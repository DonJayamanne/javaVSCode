'use strict';

import {readFileSync} from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as StringDecoder from 'string_decoder';
import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles} from 'vscode-debugadapter';
const getport = require("get-port");
import {LaunchRequestArguments} from './common/contracts';
import {open} from './common/open';
import {EventEmitter} from 'events';

const JAVA_FX_THREAD_NAME = "JavaFX Application Thread";
const JAVA_APPLICATION_EXITED = "The application exited";
// const STARTS_WITH_THREAD_NAME_REGEX = new RegExp("^[A-Za-z0-9_- ]+\\[[0-9]+\\] ");
const STARTS_WITH_THREAD_NAME_REGEX = new RegExp("^\\w+.*\\[[0-9]+\\] .*");
// const GUID_TO_PRINT = "7D985434-257C-4CA9-8BCA-18F342C73586";

//Some times the console prompt seems to end with the thread name twice!!! No idea why 
// const IS_THREAD_NAME_REGEX = new RegExp("^([A-Za-z0-9_- ]+\\[[0-9]+\\]\s*)+$");
const IS_THREAD_NAME_REGEX = new RegExp("^(.+\\[[0-9]+\\]\s*)+ $");
export interface IJdbCommandResponse {
    threadName: string;
    data: string[];
}
export enum JdbCommandType {
    StepUp,
    Continue,
    Resume,
    Run,
    Pause,
    Step,
    Next,
    Locals,
    SetBreakPoint,
    ListThreads,
    ListStack,
    Print,
    Dump,
    Exit,
    Suspend
}
interface IJdbRunnerCommand {
    command: string;
    commandLine: string;
    type: JdbCommandType;
    promise: Promise<IJdbCommandResponse>;
    promiseResolve: (IJdbCommandResponse) => void;
    finalPromise: Promise<IJdbCommandResponse>;
    printEOLCommandSent: boolean;
}
const CommandTypesThatConContainResponsesForBreakPoints = [JdbCommandType.Continue,
    JdbCommandType.Exit,
    JdbCommandType.ListStack,
    JdbCommandType.ListThreads,
    JdbCommandType.Next,
    JdbCommandType.Pause,
    JdbCommandType.Resume,
    JdbCommandType.Run,
    JdbCommandType.SetBreakPoint,
    JdbCommandType.Step,
    JdbCommandType.StepUp,
    JdbCommandType.Suspend];

/*
How to start the java server
1. java -agentlib:jdwp=transport=dt_socket,server=y,address=3003 DrawCards
2. jdb -connect com.sun.jdi.SocketAttach:hostname=localhost,port=3003
*/
export class JdbRunner extends EventEmitter {
    public jdbLoaded: Promise<string>;
    public javaLoaded: Promise<any>;
    public readyToAcceptCommands: boolean;

    public readyToAcceptBreakPoints: Promise<any>;
    private readyToAcceptBreakPointsResolve: () => void;
    private readyToAcceptBreakPointsResolved = false;

    private jdbProc: child_process.ChildProcess;
    private javaProc: child_process.ChildProcess;
    private debugSession: DebugSession;
    private className: string;
    public Exited: Promise<any>;
    private exitedResolve: () => void;
    public constructor(private sourceFile: string, private args: LaunchRequestArguments, debugSession: DebugSession) {
        super();
        this.debugSession = debugSession;
        this.className = typeof args.startupClass === "string" && args.startupClass.length > 0 ? args.startupClass : path.basename(this.sourceFile, path.extname(this.sourceFile));
        this.jdbLoaded = new Promise<string>((resolve) => {
            this.jdbLoadedResolve = resolve;
        });
        this.readyToAcceptBreakPoints = new Promise<string>((resolve) => {
            this.readyToAcceptBreakPointsResolve = resolve;
        });

        this.startProgramInDebugJavaMode().then(port => {
            this.initProc(port);
        });
        this.Exited = new Promise<any>((resolve, reject) => {
            this.exitedResolve = resolve;
        });
    }

    private sendRemoteConsoleLog(msg) {
        this.debugSession.sendEvent(new OutputEvent(msg));
    }

    private initProc(port: number) {
        var fileDir = path.dirname(this.sourceFile);
        var jdbPath = this.args.jdkPath ? path.join(this.args.jdkPath, "jdb") : "jdb";
        var args = ["-connect", `com.sun.jdi.SocketAttach:hostname=localhost,port=${port}`];
        // if (this.args.externalConsole === true) {
        //     open({ wait: false, app: [jdbPath].concat(args), cwd: fileDir }).then(proc=> {
        //         this.jdbProc = proc;
        //     }, error=> {
        //         if (!this.debugServer && this.debugServer.IsRunning) {
        //             return;
        //         }
        //         this.displayError(error);
        //     });

        //     return;
        // } 
        var that = this;
        this.jdbProc = child_process.spawn(jdbPath, args, {
            cwd: fileDir
        });
        this.jdbProc.stdout.on("data", (data) => {
            that.onDataReceived(data);
        });
        this.jdbProc.stdout.on("end", (data) => {
            that.onDataReceived(data);
        });
        this.jdbProc.stdout.on("error", (data) => {
            that.sendRemoteConsoleLog("Jdb Error " + data);
        });
        this.jdbProc.stdout.on("exit", (data) => {
        });
        this.jdbProc.stderr.on("data", (data) => {
            that.sendRemoteConsoleLog("Jdb Error Data" + data);
        });
        this.jdbProc.stdout.on("close", (data) => {
            that.onDataReceived("", true);
        });
    }

    private javaServerAppStarted: boolean;
    private startProgramInDebugJavaMode(): Promise<number> {
        return getport().then((port: number) => {
            var fileDir = path.dirname(this.sourceFile);
            var javaPath = (!this.args.jdkPath || this.args.jdkPath.length === 0) ? "java" : path.join(this.args.jdkPath, "java");
            var args = [`-agentlib:jdwp=transport=dt_socket,server=y,address=${port}`].concat(this.args.options).concat(this.className);
            this.javaProc = child_process.spawn(javaPath, args, {
                cwd: fileDir
            });

            this.javaLoaded = new Promise<number>((resolve) => {
                this.javaLoadedResolve = resolve;
            });

            //read the jdb output
            var that = this;
            var accumulatedData = "";
            this.javaProc.stdout.on("data", (data) => {
                var dataStr = new Buffer(data).toString('utf-8');
                if (this.javaServerAppStarted) {
                    if (!this.args.externalConsole) {
                        that.debugSession.sendEvent(new OutputEvent(dataStr));
                    }
                }
                else {
                    accumulatedData += dataStr;
                    if (accumulatedData.indexOf("Listening for transport") === 0 && accumulatedData.trim().endsWith(port.toString())) {
                        accumulatedData = "";
                        this.javaServerAppStarted = true;
                        this.javaLoadedResolve(port);
                    }
                }
            });
            this.javaProc.stdout.on("error", (data) => {
                that.debugSession.sendEvent(new OutputEvent("Java Error" + data, "error"));
            });
            this.javaProc.stdout.on("exit", (data) => {
            });
            this.javaProc.stdout.on("close", (data) => {
                that.onDataReceived("", true);
            });
            this.javaProc.stderr.on("data", (data) => {
                that.debugSession.sendEvent(new OutputEvent("Java Error Data" + data, "error"));
            });
            return this.javaLoaded;
        });
    }

    public sendCmd(command: string, type: JdbCommandType): Promise<IJdbCommandResponse> {
        var resp = this.sendCmdInternal(command, type);

        //Sometimes it hangs (obviously there's a bug somewhere)
        //this.onDataReceived("", false);

        return resp;
    }
    private sendCmdInternal(command: string, type: JdbCommandType): Promise<IJdbCommandResponse> {
        if (this.exited) {
            return Promise.resolve({ threadName: "", data: [] });
        }
        var jdbCmd: IJdbRunnerCommand = <IJdbRunnerCommand>{ command: command, type: type };
        jdbCmd.finalPromise = new Promise<IJdbCommandResponse>(resolve => {
            var promiseToUse = this.jdbLoaded;
            if (type === JdbCommandType.SetBreakPoint || type === JdbCommandType.Run) {
                promiseToUse = this.readyToAcceptBreakPoints
            }
            promiseToUse.then(() => {
                jdbCmd.promise = new Promise<IJdbCommandResponse>(resolve => {
                    jdbCmd.promiseResolve = resolve;
                });
                jdbCmd.promise.then(resolve);

                this.pendingCommands.push(jdbCmd);
                this.checkAndSendCommand();
            });
        });

        return jdbCmd.finalPromise;
    }

    private checkAndSendCommand() {
        if (this.exited) {
            this.pendingCommands.forEach(cmd => {
                cmd.promiseResolve([]);
            });
            return;
        }

        if (this.executingCommands.length === 0) {
            if (this.pendingCommands.length > 0) {
                var jdbCmd = this.pendingCommands[0];
                this.executingCommands.push(jdbCmd);
                jdbCmd.commandLine = this.lastLineInCommandWindow + jdbCmd.command;
                this.jdbProc.stdin.write(jdbCmd.command + "\n");

                // if (jdbCmd.type === JdbCommandType.ListThreads || jdbCmd.type === JdbCommandType.ListStack ||
                //     jdbCmd.type === JdbCommandType.Locals || jdbCmd.type === JdbCommandType.Dump ||
                //     jdbCmd.type === JdbCommandType.Print) {
                //     this.jdbProc.stdin.write(`print "${GUID_TO_PRINT}"\n`);
                // }
            }
            return;
        }

        var currentCmd = this.executingCommands[0];
        currentCmd.promise.then(() => {
            this.checkAndSendCommand();
        });
    }

    private checkIfBreakpointWillBeHit(lines: string[]): boolean {
        return lines.some(line => line.indexOf("Breakpoint hit:") >= 0);
    }
    private checkIfDebuggerWillStopDueToInvalidBreakPoints(lines: string[]): boolean {
        return lines.some(line => line.indexOf("Unable to set deferred breakpoint ") >= 0) ||
            lines.some(line => line.indexOf("Stopping due to deferred breakpoint errors.") >= 0);
    }

    private checkIfBreakpointWasHitLast(lines: string[], afterCmd?: IJdbRunnerCommand): boolean {
        var lastLine = lines[lines.length - 1];
        if (IS_THREAD_NAME_REGEX.test(lastLine) && lines.some(line => line.indexOf("Breakpoint hit:") >= 0)) {
            this.lastThreadName = lastLine.substring(0, lastLine.indexOf("[")).trim()
            if (afterCmd) {
                //If a command has been passed, then raise the event after that command has been resolved
                //I.e. after the sender of the command has handled the response as well
                afterCmd.finalPromise.then(() => {
                    this.emit("breakpointHit", this.lastThreadName);
                });
            }
            else {
                this.emit("breakpointHit", this.lastThreadName);
            }
            this.outputBuffer = "";
            return true;
        }

        return false;
    }


    private checkIfBreakpointWasHit(threadName: string, data: string[], afterCmd?: IJdbRunnerCommand): boolean {
        //Check if we have hit a breakpoint
        //Breakpoint hit:
        if (data.some(line => line.indexOf("Breakpoint hit:") >= 0)) {
            if (afterCmd) {
                //If a command has been passed, then raise the event after that command has been resolved
                afterCmd.finalPromise.then(() => {
                    this.emit("breakpointHit", threadName);
                });
            }
            else {
                this.emit("breakpointHit", threadName);
            }
            return true;
        }

        return false
    }
    private breakIfDebuggerStoppedDueToInvalidBreapoints(lines: string[], lastLine: string, afterCmd?: IJdbRunnerCommand): boolean {
        if (this.hasDebuggerStoppedDueToInvalidBreakPoints(lines, lastLine)) {
            this.lastThreadName = lastLine.substring(0, lastLine.indexOf("[")).trim()
            if (afterCmd) {
                //If a command has been passed, then raise the event after that command has been resolved
                afterCmd.finalPromise.then(() => {
                    this.emit("debuggerStopInvalidBreakPoints", this.lastThreadName);
                });
            }
            else {
                this.emit("debuggerStopInvalidBreakPoints", this.lastThreadName);
            }
            this.outputBuffer = "";
            return true;
        }

        return false;
    }

    private hasDebuggerStoppedDueToInvalidBreakPoints(lines: string[], lastLine: string) {
        var breakPointWillBeHit = this.checkIfBreakpointWillBeHit(lines);
        //if we set invalid breakpoints, then the debugger stops with the message
        //Unable to set deferred breakpoint Threading:85 : No code at line 85 in Threading
        //Stopping due to deferred breakpoint errors.
        //A number of such messages raise
        //Finally this ends with the main thread (generally "main[1]")
        //If this happens, we need to continue processing by running "run" again
        //But do this only if breakpoint has NOT been hit
        if (!breakPointWillBeHit && IS_THREAD_NAME_REGEX.test(lastLine) &&
            lines.some(line => line.indexOf("Unable to set deferred breakpoint ") >= 0) &&
            lines.some(line => line.indexOf("Stopping due to deferred breakpoint errors.") >= 0)) {

            //Reset the run command message
            return true;
        }

        return false;
    }

    private checkRestOfTheResponse(lines: string[], lastLine: string, startIndex: number, indexOfEndOfResponse: number, lastCmd?: IJdbRunnerCommand): boolean {
        if (this.checkIfBreakpointWasHitLast(lines)) {
            return true;
        }

        if (this.breakIfDebuggerStoppedDueToInvalidBreapoints(lines, lastLine, lastCmd)) {
            this.outputBuffer = "";
            return true;
        }

        if (indexOfEndOfResponse === lines.length - 1 && (lastLine.trim() === ">" || IS_THREAD_NAME_REGEX.test(lastLine))) {
            if (IS_THREAD_NAME_REGEX.test(lastLine)) {
                this.lastThreadName = lastLine.substring(0, lastLine.indexOf("[")).trim()
            }
            this.outputBuffer = "";
            return true;
        }

        //Ok, this means there's more in the message
        //I.e. we have a partial message in the response
        //Find the index of the ">" or the threadName
        let newLines = lines.slice(indexOfEndOfResponse);
        this.outputBuffer = newLines.join(os.EOL);
        return false;
    }

    private outputBuffer: string = "";
    private stringDecoder = new StringDecoder.StringDecoder('utf8');
    private pendingCommands: IJdbRunnerCommand[] = [];
    private executingCommands: IJdbRunnerCommand[] = [];
    private jdbLoadedResolve: (threadName: string) => void;
    private javaLoadedResolve: (number) => void;
    private stopAtInitSent: boolean;
    private stopAtCliInitSent: boolean;
    private stopAtMainSent: boolean;
    private runCommandSent: boolean;
    private runCommandCompleted: boolean;
    private exited: boolean;
    private lastThreadName: string = "";
    private lastLineInCommandWindow: string = "";
    private breakAtStartupClassSent = false;
    private vmStarted: boolean;
    private responseLines: string[] = [];
    private previousMessageEndedWithLineBreak = false;
    private totalResponse: string = "";
    private onDataReceived(data, exit: boolean = false) {
        this.outputBuffer = this.outputBuffer + new Buffer(data).toString('utf-8');
        this.totalResponse += data.toString();
        this.previousMessageEndedWithLineBreak = this.outputBuffer.endsWith(os.EOL);

        var lines = this.outputBuffer.split(/(\r?\n)/g).filter(line => line !== os.EOL && line !== "\n" && line !== "\r");
        if (lines.length === 0) {
            return;
        }

        // let bufferAltered = false;
        // while (lines.length > 0 && lines[0].endsWith(`"${GUID_TO_PRINT}" = "${GUID_TO_PRINT}"`)) {
        //     lines.shift();
        //     bufferAltered = true;
        // }
        // if (bufferAltered) {
        //     this.outputBuffer = lines.join(os.EOL);
        // }

        var lastLine = lines[lines.length - 1];

        if (this.executingCommands.length === 0 && lastLine.trim().endsWith("]") && this.outputBuffer.indexOf("VM Started") > 0 && !this.vmStarted) {
            this.lastLineInCommandWindow = lastLine;
            if (IS_THREAD_NAME_REGEX.test(lastLine)) {
                this.lastThreadName = lastLine.substring(0, lastLine.indexOf("[")).trim()
            }
            this.vmStarted = true;
            this.outputBuffer = "";
            this.sendCmdInternal(`stop in ${this.className}.main\n`, JdbCommandType.SetBreakPoint).then(() => {
                // Let this go into the queue, then we can start the program by sending the run command (after a few milli seconds)
                this.runCommandSent = true;
                this.sendCmdInternal("run", JdbCommandType.Run).then(resp => {
                    this.readyToAcceptCommands = true;
                    this.jdbLoadedResolve(resp.threadName);
                });
            });

            //Next, ensure we can accept breakpoints
            this.readyToAcceptBreakPointsResolve();
            return;
        }
        if (!this.vmStarted) {
            return;
        }
        if (this.executingCommands.length === 0 &&
            (lastLine.trim().endsWith(JAVA_APPLICATION_EXITED) ||
                (lines.length >= 2 && lines[lines.length - 2].trim().endsWith(JAVA_APPLICATION_EXITED))) &&
            !this.readyToAcceptCommands) {

            this.outputBuffer = "";
            this.readyToAcceptCommands = true;
            this.jdbLoadedResolve.call(this);

            this.exited = true;
            this.exitedResolve();
            return;
        }


        var removeLastLine = true;
        var lastCmd = this.executingCommands.length === 0 ? null : this.executingCommands[this.executingCommands.length - 1];

        //If we haven't yet sent the run command, that means we're still dealing with breakpoints
        if (!this.runCommandSent && lastCmd && lastCmd.type === JdbCommandType.SetBreakPoint) {
            //Breakpoint could have been deferred 
            //Find the end of the command response
            // let endResponse = lines.findIndex(line => IS_THREAD_NAME_REGEX.test(line.trim()));
            // let endResponse = lines.findIndex(line => line.indexOf("[") > 0 && line.trim().endsWith("]"));
            // if (endResponse >= 0) {
            if (IS_THREAD_NAME_REGEX.test(lastLine)) {
                this.outputBuffer = "";
                //Note, at this point the main thread is still the same as it was when the debugger loaded, most likely "main[1]""
                this.sendResponseForLastCommand(lastCmd, lines);
            }
            return;
        }
        if (this.runCommandSent && !this.runCommandCompleted && lastCmd && lastCmd.type === JdbCommandType.Run) {
            //This is a tricky one
            //Possible results include:
            //1. The app is running and no breakpoints hit, nothing - code is running 
            //>   
            //2. The debugger has initialized the breakpoint as the code is loaded
            //> Set deferred breakpoint Threading.main
            //Breakpoint hit: "threading=main", Threading.main(), lint=27 bci=0
            //27             CompileFromSockets(101);
            //   
            //3. Breakpoints initialized and running
            //> Set deferred breakpoint MyClientThread:82
            //    

            //Either way all we need to do is wait for the ">" and we know everything is know
            if (lines.length > 0 && lines.some(line => line.indexOf(">") >= 0)) {
                // if (this.hasDebuggerStoppedDueToInvalidBreakPoints(lines, lastLine)) {
                //     this.outputBuffer = "";
                //     this.lastThreadName = lastLine.substring(0, lastLine.indexOf("[")).trim()
                //     //resend the run command
                //     this.jdbProc.stdin.write("run\n");
                //     return;
                // }

                this.runCommandCompleted = true;

                //Ok strip off the first line from the buffer, the other lines could contain breakpoints being hit (e.g. example 2)
                let indexOfLineBreak = this.outputBuffer.indexOf(os.EOL);
                if (indexOfLineBreak >= 0) {
                    this.outputBuffer = this.outputBuffer.substring(indexOfLineBreak);
                }
                else {
                    this.outputBuffer = "";
                }

                this.sendResponseForLastCommand(lastCmd, [lines[0]]);

                //Another problem now,

                //Now check if we hit a breakpoint
                if (!this.checkIfBreakpointWasHitLast(lines, lastCmd)) {
                    if (lastLine.indexOf("]") > lastLine.indexOf("[")) {
                        this.lastThreadName = lastLine.substring(0, lastLine.indexOf("[")).trim()
                    }
                    else {
                        if (lines.length === 1) {
                            this.lastThreadName = "";
                        }
                    }
                }

                //Either a breakpoint wasn't hit or we don't have the complete output from the debugger
                return;
            }
        }

        //If no last command and we have some output, then this is most likely a breakpoint being initialized or a breakpoint being hit
        //If a breakpoint has been hit, then the last line MUST be the thread name
        if (lastCmd === null && (this.checkIfBreakpointWasHitLast(lines) || this.breakIfDebuggerStoppedDueToInvalidBreapoints(lines, lastLine))) {
            return;
        }
        if (lastCmd === null && this.checkIfBreakpointWillBeHit(lines)) {
            return;
        }
        if (lastCmd === null && this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
            return;
        }

        //If a breakpoint was hit, we'd request the threads
        //Or if no breakpoint has been hit (e.g. if we pause), then the last active thread is ">" (i.e. nothing)
        if (lastCmd && (lastCmd.type === JdbCommandType.ListThreads || lastCmd.type === JdbCommandType.ListStack ||
            lastCmd.type === JdbCommandType.Locals || lastCmd.type === JdbCommandType.Dump ||
            lastCmd.type === JdbCommandType.Print)) {

            // if (!lastCmd.printEOLCommandSent) {
            //     lastCmd.printEOLCommandSent = true;
            //     this.jdbProc.stdin.write(`print "${GUID_TO_PRINT}"\n`);
            //     return;
            // }

            //We're now looking for a line that starts with ">" or "main[1]" (thread name)
            // let indexOfEndOfResponse = lines.findIndex(line => line.indexOf(">") === 0 || STARTS_WITH_THREAD_NAME_REGEX.test(line));
            var reversedArray = lines.slice().reverse();
            let indexOfEndOfResponse = reversedArray.findIndex(line => line.startsWith(this.lastThreadName + "["));
            if (indexOfEndOfResponse === -1) {
                return;
            }

            // let indexOfEndOfResponse = lines.findIndex(line => line.indexOf(`"${GUID_TO_PRINT}" = "${GUID_TO_PRINT}"`) >= 0);

            // let indexOfEndOfResponse = lines.findIndex(line => line.indexOf(">") === 0 || (line.trim().indexOf("[") > 0 && line.trim().indexOf("]") > 0));
            // if (indexOfEndOfResponse !== -1 && (indexOfEndOfResponse + 1) <= (lines.length - 1)) {
            //Now get the proper index (remember we reversed the array to start form the bottom)
            indexOfEndOfResponse = lines.length - indexOfEndOfResponse;

            var endOfResponseLine = lines[indexOfEndOfResponse - 1];
            this.lastThreadName = endOfResponseLine.substring(0, endOfResponseLine.indexOf("[")).trim()

            let threadResponseLines = lines.slice(0, indexOfEndOfResponse - 1);

            this.sendResponseForLastCommand(lastCmd, threadResponseLines);

            if (!this.checkRestOfTheResponse(lines, lastLine, 0, indexOfEndOfResponse, lastCmd)) {
                if (this.checkIfBreakpointWillBeHit(lines) || this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
                    //We could get more messages 
                    //Ok, this means there's more in the message
                    //I.e. we have a partial message in the response
                    //Find the index of the ">" or the threadName
                    let newLines = lines.slice(indexOfEndOfResponse);
                    this.outputBuffer = newLines.join(os.EOL);
                    return;
                }

                this.outputBuffer = "";
            }
            return;
        }

        if (lastCmd && lastCmd.type === JdbCommandType.SetBreakPoint) {
            if (lines.length === 1) {
                return;
            }

            let indexToStartFrom = lines.findIndex(line => line.indexOf("Set breakpoint ") >= 0 || line.indexOf("Unable to set breakpoint ") >= 0);
            //-1 = Rare occasion, if a breakpoint gets hit even before a response for setting a breakpoint is received
            //Response in the Last line, this means we need to wait for more
            if (indexToStartFrom === -1) {
                return;
            }

            //Check if there was an end to the response
            let indexOfEndOfResponse = lines.slice(indexToStartFrom + 1).findIndex(line => line.indexOf(">") === 0 || STARTS_WITH_THREAD_NAME_REGEX.test(line));
            if (indexOfEndOfResponse === -1) {
                return;
            }

            this.sendResponseForLastCommand(lastCmd, lines.slice(indexToStartFrom, indexOfEndOfResponse + indexToStartFrom + 1));

            if (!this.checkRestOfTheResponse(lines, lastLine, 0, indexOfEndOfResponse, lastCmd)) {
                if (this.checkIfBreakpointWillBeHit(lines) || this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
                    //We could get more messages 
                    //Ok, this means there's more in the message
                    //I.e. we have a partial message in the response
                    //Find the index of the ">" or the threadName
                    let newLines = lines.slice(indexOfEndOfResponse);
                    this.outputBuffer = newLines.join(os.EOL);
                    return;
                }

                this.outputBuffer = "";
            }
            return;
        }
        if (lastCmd && (lastCmd.type === JdbCommandType.Next ||
            lastCmd.type === JdbCommandType.Step ||
            lastCmd.type === JdbCommandType.StepUp)) {

            //if we have hit a breakpoint, then it is possible we will never get a response for the previous command (set, next step up)
            if (this.checkIfBreakpointWillBeHit(lines) || this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
                var hasNonBreakPointLines = lines.some(line => line.indexOf("Breakpoint hit:") === -1 && !IS_THREAD_NAME_REGEX.test(line) && line.trim().length > 0);
                if (!hasNonBreakPointLines) {
                    if (this.checkIfBreakpointWasHitLast(lines)) {
                        this.sendResponseForLastCommand(lastCmd, lines);
                        return;
                    }

                    if (this.breakIfDebuggerStoppedDueToInvalidBreapoints(lines, lastLine, lastCmd)) {
                        this.sendResponseForLastCommand(lastCmd, lines);
                        this.outputBuffer = "";
                        return;
                    }

                    this.sendResponseForLastCommand(lastCmd, lines);
                    return;
                }
            }

            let indexToStartFrom = lines.findIndex(line => line.indexOf("Step completed: ") >= 0);
            if (indexToStartFrom === -1) {
                return;
            }

            //No need to check if theres an end
            //If we have at least 2 lines for the response, then that's fine 
            // let indexOfEndOfResponse = indexToStartFrom + 2;
            let indexOfEndOfResponse = lines.slice(indexToStartFrom + 1).findIndex(line => line.indexOf(">") === 0 || STARTS_WITH_THREAD_NAME_REGEX.test(line));
            if (indexOfEndOfResponse === -1) {
                return;
            }
            indexOfEndOfResponse = indexOfEndOfResponse + indexToStartFrom + 1;
            if (this.checkIfBreakpointWasHitLast(lines)) {
                this.sendResponseForLastCommand(lastCmd, lines.slice(indexToStartFrom, indexOfEndOfResponse));
                return;
            }

            if (this.breakIfDebuggerStoppedDueToInvalidBreapoints(lines, lastLine, lastCmd)) {
                this.sendResponseForLastCommand(lastCmd, lines.slice(indexToStartFrom, indexOfEndOfResponse));
                this.outputBuffer = "";
                return;
            }

            if (this.checkIfBreakpointWillBeHit(lines) || this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
                this.sendResponseForLastCommand(lastCmd, lines.slice(indexToStartFrom, indexOfEndOfResponse));
                return;
            }
            //this.checkRestOfTheResponse(lines, lastLine, 0, lines.length - 1, lastCmd);
            // let indexOfEndOfResponse = reversedArray.findIndex(line => line.startsWith(this.lastThreadName));
            // if (lastLine.trim() === ">" || lastLine.startsWith(this.lastThreadName)) {
            this.sendResponseForLastCommand(lastCmd, lines.slice(indexToStartFrom, indexOfEndOfResponse));
            this.outputBuffer = "";
            // }

            return;
        }
        if (lastCmd && lastCmd.type === JdbCommandType.Continue) {
            let indexToStartFrom = lines.findIndex(line => line.indexOf(">") === 0 || STARTS_WITH_THREAD_NAME_REGEX.test(line));
            if (indexToStartFrom === -1) {
                return;
            }

            this.sendResponseForLastCommand(lastCmd, lines.slice(indexToStartFrom, indexToStartFrom));
            this.checkRestOfTheResponse(lines, lastLine, 0, lines.length - 1, lastCmd);
            if (!this.checkIfBreakpointWillBeHit(lines) && !this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
                this.outputBuffer = "";
            }
            return;
        }

        if (lastCmd && (lastCmd.type === JdbCommandType.Suspend || lastCmd.type === JdbCommandType.Resume)) {
            var textToSearchFor = lastCmd.type === JdbCommandType.Suspend ? "All threads suspended." : "All threads resumed.";
            let indexToStartFrom = lines.findIndex(line => line.indexOf(textToSearchFor) >= 0);
            if (indexToStartFrom === -1) {
                return;
            }

            let indexOfEndOfResponse = lines.slice(indexToStartFrom + 1).findIndex(line => line.indexOf(">") === 0 || STARTS_WITH_THREAD_NAME_REGEX.test(line));
            if (indexOfEndOfResponse === -1) {
                return;
            }

            this.sendResponseForLastCommand(lastCmd, lines.slice(indexToStartFrom, indexOfEndOfResponse + indexToStartFrom + 1));
            // this.checkRestOfTheResponse(lines, lastLine, 0, lines.length - 1, lastCmd);


            if (this.checkIfBreakpointWasHitLast(lines)) {
                return;
            }

            if (this.breakIfDebuggerStoppedDueToInvalidBreapoints(lines, lastLine, lastCmd)) {
                this.outputBuffer = "";
                return;
            }

            if (this.checkIfBreakpointWillBeHit(lines) || this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
                return;
            }

            this.outputBuffer = "";
            return;
        }

        if (this.checkIfBreakpointWasHitLast(lines)) {
            return;
        }

        if (this.breakIfDebuggerStoppedDueToInvalidBreapoints(lines, lastLine, lastCmd)) {
            this.outputBuffer = "";
            return;
        }

        var x = "";
        if (x.length === 0) {
            return;
        }
        //If command was for setting a breakpoint, then we need to wait for a line with "main[1]" or "> "
        if (lastCmd && lastCmd.type === JdbCommandType.SetBreakPoint) {
            var indexToUse = lines.findIndex(line => line.indexOf("Deferring breakpoint ") >= 0);
            indexToUse = indexToUse === -1 ? lines.findIndex(line => line.indexOf("Set breakpoint ") >= 0) : indexToUse;
            if (indexToUse >= 0) {
                //Find the console end (this would be somethign like "main[1]" or "> ")
                var indexOfEndOfMessage = lines.slice(indexToUse).findIndex(line => line.indexOf("> ") === 0 || STARTS_WITH_THREAD_NAME_REGEX.test(line));
            }
        }

        var checkForBreakpoints = lastCmd && CommandTypesThatConContainResponsesForBreakPoints.indexOf(lastCmd.type) >= 0;
        var isEndOfLine = this.lastThreadName.length > 0 && lastLine.startsWith(this.lastThreadName + "[") && lastLine.indexOf("[") > 0;
        if (!isEndOfLine && this.executingCommands.length > 0) {
            var previousCmd = this.executingCommands[0];
            if (previousCmd.type === JdbCommandType.SetBreakPoint) {
                if (lines.some(line => line.indexOf("Deferring breakpoint") >= 0) && lines.length >= 3) {
                    //Example
                    //Deferring breakpoint <classs>:<line>
                    //It will be set after the class is loaded
                    //main[1]
                    isEndOfLine = true;
                }
                if (lines.some(line => line.indexOf("Set breakpoint") >= 0) && lines.length >= 2) {
                    //Example
                    //Set breakpoint <classs>:<line>
                    //main[1]
                    isEndOfLine = true;
                }
                //If multi threaded app, then console will not have a thread name instead it will have ">"
                if (lastLine.trim().endsWith(">")) {
                    isEndOfLine = true;
                }
                //Possible that it broke at the break point just after we set it
                checkForBreakpoints = true;
            }
            if (previousCmd.type === JdbCommandType.Step || previousCmd.type === JdbCommandType.Run || previousCmd.type === JdbCommandType.Continue) {
                if (lastLine.trim().endsWith("]")) {
                    isEndOfLine = true;
                }
            }
            if (previousCmd.command === "cont" || previousCmd.command === "step up" || previousCmd.command === "next" || previousCmd.command === "resume") {
                isEndOfLine = lastLine === "> ";
                removeLastLine = false;

                //Possible that it broke at the break point just after executed the next line of code
                checkForBreakpoints = true;
            }
            if (previousCmd.command.startsWith("stop at ") && this.outputBuffer.startsWith("Unable to set breakpoint")) {
                isEndOfLine = true;
                removeLastLine = false;
            }
            if (previousCmd.command.startsWith("stop at ") && this.outputBuffer.indexOf("Set breakpoint ") >= 0) {
                isEndOfLine = true;
                removeLastLine = false;
            }
        }
        if (this.runCommandSent && lastLine.trim().endsWith("]") && !this.runCommandCompleted) {
            this.runCommandCompleted = true;
            isEndOfLine = true;
            //Possible we have lines that contain breakpoints being hit
            checkForBreakpoints = true;
        }

        if (!isEndOfLine && this.executingCommands.length === 0) {
            //Looks like the code was running all hunky dori without, and then a breakpoint was hit
            if (this.outputBuffer.indexOf("Breakpoint hit:") >= 0 && lastLine.trim().endsWith("]")) {
                isEndOfLine = true;
                removeLastLine = false;
                checkForBreakpoints = true;
            }
        }

        if (!isEndOfLine && lastCmd && CommandTypesThatConContainResponsesForBreakPoints.indexOf(lastCmd.type) >= 0 &&
            (lastLine.trim() === ">" || lastLine.trim().endsWith("]"))) {
            if (lines.some(line => line.indexOf("Set deferred breakpoint") >= 0 || line.indexOf("Breakpoint hit: ") > 0)) {
                isEndOfLine = true;
            }
        }
        if (!isEndOfLine && lastCmd && lastCmd.type === JdbCommandType.Suspend) {
            if (lines.some(line => line.indexOf("All threads suspended.") >= 0)) {
                isEndOfLine = true;
            }
        }
        if (!isEndOfLine && lastCmd && lastCmd.type === JdbCommandType.Resume) {
            if (lines.some(line => line.indexOf("All threads resumed.") >= 0)) {
                isEndOfLine = true;
            }
        }
        if (!isEndOfLine && lastCmd && (lastCmd.type === JdbCommandType.ListStack || lastCmd.type === JdbCommandType.ListThreads)) {
            //If multi threaded app, then console will not have a thread name instead it will have ">"
            var hasNonEmptyLines = lines.some(line => line.trim().length > 0 && line.trim() !== ">");
            if (hasNonEmptyLines && lastLine.trim().startsWith(">")) {
                isEndOfLine = true;
            }
        }
        if (!isEndOfLine && lastCmd && (lastCmd.type === JdbCommandType.Locals || lastCmd.type === JdbCommandType.Dump)) {
            if (lines.some(line => line.indexOf("No default thread specified: use the \"thread\" command first.") >= 0)) {
                isEndOfLine = true;
            }
        }


        // console.log(`Number of pending Commands = ${this.executingCommands.length}`);

        if (isEndOfLine || exit === true) {
            if (this.outputBuffer.endsWith(os.EOL) || this.outputBuffer.endsWith("\r\n") || this.outputBuffer.endsWith("\n")) {
                this.lastLineInCommandWindow = lastLine;
            }
            else {
                this.lastLineInCommandWindow += lastLine;
            }


            let indexOfBreakPointHitLine = lines.findIndex(line => line.indexOf("Breakpoint hit:") >= 0);
            var threadNameForBreakPoint = "";
            if (indexOfBreakPointHitLine >= 0) {
                //We must have a line that ends with the thread name
                var indexOfThreadNameLine = lines.slice(indexOfBreakPointHitLine).findIndex(line => line.indexOf("[") > 0 && line.indexOf("]") > line.indexOf("["));
                if (indexOfThreadNameLine === -1) {
                    var indexOfBreakPointInBuffer = this.outputBuffer.indexOf("Breakpoint hit:");
                    this.outputBuffer = this.outputBuffer.substring(indexOfBreakPointInBuffer);
                }
                else {
                    threadNameForBreakPoint = lines[indexOfBreakPointHitLine + indexOfThreadNameLine];
                    threadNameForBreakPoint = threadNameForBreakPoint.substring(0, threadNameForBreakPoint.indexOf("["));
                    this.outputBuffer = "";
                }
            }
            else {
                this.outputBuffer = "";
            }

            if (exit) {
                debugger;
            }

            //Get the thread name (last entry, e.g. main[1])
            for (let counter = lines.length - 1; counter > 0; counter--) {
                if (lines[counter].trim().length > 0) {
                    let threadName = lines[counter].trim();
                    if (threadName.endsWith("]")) {
                        threadName = threadName.substring(0, threadName.indexOf("["));
                        this.lastThreadName = threadName;
                        break;
                    }
                    break;
                }
            }

            if (removeLastLine) {
                lines.pop();
            }
            //If the application exits, the the last line is "the application exited" message followed by a new line
            if (exit) {
                debugger;
                lines.pop();
            }

            if (lastCmd) {
                this.sendResponseForLastCommand(lastCmd, lines);
            }
            if (lastCmd === null || checkForBreakpoints) {
                if (threadNameForBreakPoint.length === 0) {
                    threadNameForBreakPoint = this.lastThreadName;
                }
                this.checkIfBreakpointWasHit(this.lastThreadName, lines);
            }

            if (exit) {
                this.exited = true;
                this.exitedResolve();
            }
        }
    }

    private sendResponseForLastCommand(lastCmd: IJdbRunnerCommand, lines: string[]) {
        this.pendingCommands.shift();
        this.executingCommands.pop();
        lastCmd.promiseResolve({ threadName: this.lastThreadName, data: lines });
    }
}