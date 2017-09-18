import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as child_process from 'child_process';
import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles} from 'vscode-debugadapter';
const getport = require("get-port");
import {AttachRequestArguments, LaunchRequestArguments, isAttachRequestArguments} from './common/contracts';
import {open} from './common/open';
import {EventEmitter} from 'events';
import {WaitForPortToOpen} from './common/waitForPortToOpen';

const JAVA_APPLICATION_EXITED = "The application exited";
const STARTS_WITH_THREAD_NAME_REGEX = new RegExp("^\\w+.*\\[[0-9]+\\] .*");
//Some times the console prompt seems to end with the thread name twice!!! No idea why
const IS_THREAD_NAME_REGEX = new RegExp("^(.+\\[[0-9]+\\]\s*)+ $");
const IS_PROMPT = new RegExp("^> *$");

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
    SetBreakpoint,
    ClearBreakpoint,
    ListThreads,
    ListStack,
    Print,
    Dump,
    Exit,
    Suspend
}
interface IJdbRunnerCommand {
    command: string;
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
    JdbCommandType.SetBreakpoint,
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
    private jdbLoadedResolve: (threadName: string) => void;
    private jdbLoadedReject: (any) => void;

    public javaLoaded: Promise<any>;
    private javaLoadedResolve: (number) => void;
    private javaLoadedReject: (any) => void;

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
    public constructor(private args: LaunchRequestArguments | AttachRequestArguments, debugSession: DebugSession) {
        super();
        this.debugSession = debugSession;
        // if using VSCode's ${relativeFile}, it will default to src/main/java/${file}.java
        var startupClassMatch = args.startupClass.match(new RegExp(`${args.startupClassPathPattern}(.*)`));
        if(startupClassMatch){
            args.startupClass = startupClassMatch[1];
            args.startupClass = args.startupClass.substring(0, args.startupClass.lastIndexOf('.java'));
            args.startupClass = args.startupClass.replace(/\//g, '.');
        }
        let ext = path.extname(args.startupClass);
        this.className = path.basename(args.startupClass, ext.toUpperCase() === ".JAVA" ? ext : "");
        this.jdbLoaded = new Promise<string>((resolve, reject) => {
            this.jdbLoadedResolve = resolve;
            this.jdbLoadedReject = reject;
        });
        this.readyToAcceptBreakPoints = new Promise<string>((resolve) => {
            this.readyToAcceptBreakPointsResolve = resolve;
        });
        if (isAttachRequestArguments(args)) {

            if (! args.remoteHost) {
                args.remoteHost = "localhost";
            }
            this.initProc(args.remotePort, args.remoteHost);
        } else {
            this.startProgramInDebugJavaMode().then(port => {
                this.initProc(port, "localhost");       // This always spins up the application on the local machine.
            }).catch(this.jdbLoadedReject);
        }

        this.Exited = new Promise<any>((resolve, reject) => {
            this.exitedResolve = resolve;
        });

        this.jdbLoaded.catch(() => this.killProcesses());
        this.Exited.then(() => this.killProcesses());
    }

    private killProcesses() {
        try {
            this.jdbProc.kill();
            this.jdbProc = null;
        }
        catch (ex) {

        }
        try {
            this.javaProc.kill();
            this.javaProc = null;
        }
        catch (ex) {

        }
    }
    private sendRemoteConsoleLog(msg) {
        this.debugSession.sendEvent(new OutputEvent(msg));
    }

    private initProc(port: number, hostname: string) {
        var jdbPath = this.args.jdkPath ? path.join(this.args.jdkPath, "jdb") : "jdb";
        var args = ["-connect", `com.sun.jdi.SocketAttach:hostname=${hostname},port=${port}`];
        if (this.args.sourcePath) {
            args = args.concat("-sourcepath", this.args.sourcePath.join(path.delimiter));
        }
        this.jdbProc = child_process.spawn(jdbPath, args, {
            cwd: this.args.cwd
        });
        this.jdbProc.stdout.on("data", (data) => {
            this.onDataReceived(data);
        });
        this.jdbProc.stderr.on("data", (data) => {
            let message: string;
            if (data instanceof Error) {
                message = (<Error>data).name + ": " + (<Error>data).message;
            } else if (data instanceof Buffer) {
                message = data.toString('utf-8');
            } else {
                message = data;
            }
            if (this.javaServerAppStarted && this.readyToAcceptCommands) {
                this.debugSession.sendEvent(new OutputEvent(message, "error"));
            }
            else {
                this.exited = true;
                this.jdbLoadedReject("Failed to start jdb, " + message);
            }
        });
        this.jdbProc.stdout.on("close", (data) => {
            this.onDataReceived("", true);
        });
        this.jdbProc.on("error", (data) => {
            if (this.javaServerAppStarted && this.readyToAcceptCommands) {
                var message: string;
                if (data instanceof Error) {
                    message = (<Error>data).name + ": " + (<Error>data).message;
                } else {
                    message = data;
                }
                this.debugSession.sendEvent(new OutputEvent("jdb Error " + message, "error"));
            }
            else {
                this.exited = true;
                this.jdbLoadedReject(data);
            }
        });
    }

    private javaServerAppStarted: boolean;
    private startProgramInDebugJavaMode(): Promise<number> {
        return getport().then((port: number) => {
            this.javaLoaded = new Promise<number>((resolve, reject) => {
                this.javaLoadedResolve = resolve;
                this.javaLoadedReject = reject;
            });

            var javaPath = (!this.args.jdkPath || this.args.jdkPath.length === 0) ? "java" : path.join(this.args.jdkPath, "java");
            var classpath = this.args.classpath || [];
            var classpathOptions = [];
            if (classpath.length > 0) {
                classpathOptions = ["-classpath", classpath.join(os.platform() === "win32" ? ";" : ":")];
            }
            var options = this.args.options || [];
            if (options.indexOf("-classpath") !== -1 || options.indexOf("-cp") !== -1) {
                this.debugSession.sendEvent(
                    new OutputEvent("Warning: Specifying -classpath in options of launch.json is deprecated. Please use the classpath option instead.", "console")
                );
            }
            var args = [`-agentlib:jdwp=transport=dt_socket,server=y,address=${port}`].concat(classpathOptions).concat(options).concat(this.className).concat(this.args.args || []);
            if (this.args.externalConsole === true) {
                open({ wait: false, app: [javaPath].concat(args), cwd: this.args.cwd }).then(proc => {
                    this.javaProc = proc;
                    this.handleJavaOutput(port);
                }, error => {
                    this.onJavaErrorHandler(error);
                });
            }
            else {
                this.javaProc = child_process.spawn(javaPath, args, {
                    cwd: this.args.cwd
                });
                this.handleJavaOutput(port);
            }

            return this.javaLoaded;
        });
    }

    private handleJavaOutput(port: number) {
        //read the jdb output
        var accumulatedData = "";
        if (this.args.externalConsole) {
            WaitForPortToOpen(port, 5000).then(() => {
                this.javaServerAppStarted = true;
                this.javaLoadedResolve(port);
            })
                .catch(error => {
                    let message = error.message ? error.message : error;
                    if (this.javaServerAppStarted && this.readyToAcceptCommands) {
                        this.debugSession.sendEvent(new OutputEvent(message));
                    }
                    else {
                        this.exited = true;
                        this.javaLoadedReject("Failed to start the program, " + message);
                    }
                });
            return;
        }

        if (this.args.listenerMessage == null) {
            this.args.listenerMessage = "Listening for transport";
        } else if (this.args.listenerMessage == "-") {
            this.javaServerAppStarted = true;
            this.javaLoadedResolve(port);
        }

        this.javaProc.stdout.on("data", (data) => {
            var dataStr = data.toString();
            if (this.javaServerAppStarted && this.readyToAcceptCommands) {
                if (!this.args.externalConsole) {
                    this.debugSession.sendEvent(new OutputEvent(dataStr, "stdout"));
                }
            }
            else {
                accumulatedData += dataStr;
                if (accumulatedData.indexOf(this.args.listenerMessage) === 0 && accumulatedData.trim().endsWith(port.toString())) {
                    accumulatedData = "";
                    this.javaServerAppStarted = true;
                    this.javaLoadedResolve(port);
                }
            }
        });
        this.javaProc.stdout.on("close", (data) => {
            if (!this.javaServerAppStarted && !this.readyToAcceptCommands) {
                this.exited = true;
                this.javaLoadedReject(accumulatedData);
                this.debugSession.sendEvent(new OutputEvent(accumulatedData));
                return;
            }
            this.onDataReceived("", true);
        });
        this.javaProc.stderr.on("data", (data) => {
            var message = data.toString();
            if (this.javaServerAppStarted && this.readyToAcceptCommands) {
                this.debugSession.sendEvent(new OutputEvent(message, "stderr"));
            }
            else {
                this.exited = true;
                this.javaLoadedReject(message);
                this.debugSession.sendEvent(new OutputEvent(message));
            }
        });
        this.javaProc.on("error", (data) => {
            this.onJavaErrorHandler(data);
        });
    }

    private onJavaErrorHandler(data: any) {
        var message = data;
        if (data instanceof Error) {
            message = (<Error>data).name + ": " + (<Error>data).message;
        }
        if (this.javaServerAppStarted && this.readyToAcceptCommands) {
            this.debugSession.sendEvent(new OutputEvent("Java Error " + message, "error"));
        }
        else {
            this.exited = true;
            this.javaLoadedReject("Failed to start the program, " + message);
        }
    }

    public sendCmd(command: string, type: JdbCommandType): Promise<IJdbCommandResponse> {
        if (this.exited) {
            return Promise.resolve({ threadName: "", data: [] });
        }
        var jdbCmd: IJdbRunnerCommand = <IJdbRunnerCommand>{ command: command, type: type };
        jdbCmd.finalPromise = new Promise<IJdbCommandResponse>(resolve => {
            var promiseToUse = this.jdbLoaded;
            if (type === JdbCommandType.SetBreakpoint || type === JdbCommandType.Run) {
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
                this.jdbProc.stdin.write(jdbCmd.command + "\n");
            }
            return;
        }

        var currentCmd = this.executingCommands[0];
        currentCmd.promise.then(() => {
            this.checkAndSendCommand();
        });
    }

    private outputBuffer: string = "";
    private pendingCommands: IJdbRunnerCommand[] = [];
    private executingCommands: IJdbRunnerCommand[] = [];
    private runCommandSent: boolean;
    private runCommandCompleted: boolean;
    private exited: boolean;
    private lastThreadName: string = "";
    private vmStarted: boolean;
    private onDataReceived(data, exit: boolean = false) {
        this.outputBuffer = this.outputBuffer + new Buffer(data).toString('utf-8');
        var lines = this.outputBuffer.split(/(\r?\n)/g).filter(line => line !== os.EOL && line !== "\n" && line !== "\r");
        if (lines.length === 0) {
            return;
        }
        var lastLine = lines[lines.length - 1];

        if (this.executingCommands.length === 0 && !this.vmStarted) {
            if (lastLine.trim().endsWith("]") && this.outputBuffer.indexOf("VM Started") > 0) {
                this.vmStarted = true;
            } else if (IS_PROMPT.test(lastLine)) {
                this.vmStarted = true;
            }
            if (this.vmStarted) {
                if (IS_THREAD_NAME_REGEX.test(lastLine)) {
                    this.lastThreadName = lastLine.substring(0, lastLine.indexOf("[")).trim()
                }
                this.outputBuffer = "";

                let startedPromise = Promise.resolve<IJdbCommandResponse>(null);
                if (this.args.stopOnEntry) {
                    startedPromise = this.sendCmd(`stop in ${this.className}.main\n`, JdbCommandType.SetBreakpoint);
                }
                startedPromise.then(() => {
                    // Let this go into the queue, then we can start the program by sending the run command (after a few milli seconds)
                    this.runCommandSent = true;
                    this.sendCmd("run", JdbCommandType.Run).then(resp => {
                        this.readyToAcceptCommands = true;
                        this.jdbLoadedResolve(resp.threadName);
                    });
                });
                //Next, ensure we can accept breakpoints
                this.readyToAcceptBreakPointsResolve();
                return;
            }
        }
        if (!this.vmStarted) {
            return;
        }
        if (this.executingCommands.length === 0 &&
            lines.some(line => line === JAVA_APPLICATION_EXITED) &&
            lines.filter(line => line.trim().length > 0).length === 1 &&
            !this.readyToAcceptCommands) {

            this.outputBuffer = "";
            this.readyToAcceptCommands = true;
            this.jdbLoadedResolve.call(this);

            this.exited = true;
            this.exitedResolve();
            return;
        }
        //If the application exits, the the last line is "the application exited" message followed by a new line
        if (exit) {
            this.exited = true;
            this.exitedResolve();
            return;
        }

        var lastCmd = this.executingCommands.length === 0 ? null : this.executingCommands[this.executingCommands.length - 1];

        if (!lastCmd) {
            //If no last command and we have some output, then this is most likely a breakpoint being initialized or a breakpoint being hit
            //If a breakpoint has been hit, then the last line MUST be the thread name
            if ((this.checkIfBreakpointWasHitLast(lines) || this.breakIfDebuggerStoppedDueToInvalidBreapoints(lines, lastLine))) {
                return;
            }
            if (this.checkIfBreakpointWillBeHit(lines)) {
                return;
            }
            if (this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
                return;
            }
        }

        let lastCmdType = lastCmd ? lastCmd.type : null;
        switch (lastCmdType) {
            case JdbCommandType.Run: {
                this.processRunCommand(lines, lastLine, lastCmd);
                return;
            }
            //If a breakpoint was hit, we'd request the threads
            //Or if no breakpoint has been hit (e.g. if we pause), then the last active thread is ">" (i.e. nothing)
            case JdbCommandType.ListThreads:
            case JdbCommandType.ListStack:
            case JdbCommandType.Locals:
            case JdbCommandType.Dump:
            case JdbCommandType.Print: {
                this.processQueryCommands(lines, lastLine, lastCmd);
                return;
            }
            case JdbCommandType.ClearBreakpoint:
            case JdbCommandType.SetBreakpoint: {
                //If we haven't yet sent the run command, that means we're still dealing with breakpoints
                if (!this.runCommandSent && lastCmd.type === JdbCommandType.SetBreakpoint) {
                    //Breakpoint could have been deferred
                    //Find the end of the command response
                    // let endResponse = lines.findIndex(line => IS_THREAD_NAME_REGEX.test(line.trim()));
                    // let endResponse = lines.findIndex(line => line.indexOf("[") > 0 && line.trim().endsWith("]"));
                    // if (endResponse >= 0) {
                    if (IS_THREAD_NAME_REGEX.test(lastLine) || IS_PROMPT.test(lastLine)) {
                        this.outputBuffer = "";
                        //Note, at this point the main thread is still the same as it was when the debugger loaded, most likely "main[1]""
                        this.sendResponseForLastCommand(lastCmd, lines);
                    }
                    return;
                }

                this.processBreakpoint(lines, lastLine, lastCmd);
                return;
            }

            case JdbCommandType.Next:
            case JdbCommandType.Step:
            case JdbCommandType.StepUp: {

                this.processCodeStepping(lines, lastLine, lastCmd);
                return;
            }
            case JdbCommandType.Continue: {
                this.processContinue(lines, lastLine, lastCmd);
                return;
            }
            case JdbCommandType.Suspend:
            case JdbCommandType.Resume: {
                this.processSuspendAndResume(lines, lastLine, lastCmd);
                return;
            }

            default:
                break;
        }

        if (this.checkIfBreakpointWasHitLast(lines)) {
            return;
        }

        if (this.breakIfDebuggerStoppedDueToInvalidBreapoints(lines, lastLine, lastCmd)) {
            this.outputBuffer = "";
            return;
        }
    }

    private sendResponseForLastCommand(lastCmd: IJdbRunnerCommand, lines: string[]) {
        this.pendingCommands.shift();
        this.executingCommands.pop();
        lastCmd.promiseResolve({ threadName: this.lastThreadName, data: lines });
    }

    private processQueryCommands(lines: string[], lastLine: string, lastCmd: IJdbRunnerCommand) {
        //We're now looking for a line that starts with ">" or "main[1]" (thread name)
        // let indexOfEndOfResponse = lines.findIndex(line => line.indexOf(">") === 0 || STARTS_WITH_THREAD_NAME_REGEX.test(line));
        var reversedArray = lines.slice().reverse();
        let indexOfEndOfResponse = reversedArray.findIndex(line => line.startsWith(this.lastThreadName + "[") || IS_THREAD_NAME_REGEX.test(line) || IS_PROMPT.test(line));
        if (indexOfEndOfResponse === -1) {
            //However sometimes, we have breakpoints being hit, and the response gets mangled pause
            //We have the text "Breakpoint hit: Group System: .." (responses for multiple commands getting mixed)
            //This is to be expected as we have multiple threads (I think multiple threads) writing to the same stream (hmmm)
            //Anyways

            //Question is how on earth do we handle this situtation
            //Proper Solution - use jpda (instead of jdb)
            return;
        }

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
    }

    private processBreakpoint(lines: string[], lastLine: string, lastCmd: IJdbRunnerCommand) {
        if (lines.length === 1) {
            return;
        }
        let indexToStartFrom = lines.findIndex(line => line.indexOf("Set breakpoint ") >= 0 ||
            line.indexOf("Unable to set breakpoint ") >= 0 ||
            line.indexOf("Not found: ") >= 0 ||
            line.indexOf("Removed: ") >= 0 ||
            line.indexOf("Deferring breakpoint ") >= 0);

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
    }

    private processCodeStepping(lines: string[], lastLine: string, lastCmd: IJdbRunnerCommand) {
        //if we have hit a breakpoint, then it is possible we will never get a response for the previous command (set, next step up)
        if (this.checkIfBreakpointWillBeHit(lines) || this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
            var hasNonBreakPointLines = lines.some(line => line.indexOf("Breakpoint hit:") === -1 && !IS_THREAD_NAME_REGEX.test(line) && line.trim().length > 0 && line.trim() !== ">");
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
        this.sendResponseForLastCommand(lastCmd, lines.slice(indexToStartFrom, indexOfEndOfResponse));
        this.outputBuffer = "";
    }

    private processContinue(lines: string[], lastLine: string, lastCmd: IJdbRunnerCommand) {
        let indexToStartFrom = lines.findIndex(line => line.indexOf(">") === 0 || STARTS_WITH_THREAD_NAME_REGEX.test(line));
        if (indexToStartFrom === -1) {
            return;
        }

        this.sendResponseForLastCommand(lastCmd, lines.slice(indexToStartFrom, indexToStartFrom));
        this.checkRestOfTheResponse(lines, lastLine, 0, lines.length - 1, lastCmd);
        if (!this.checkIfBreakpointWillBeHit(lines) && !this.checkIfDebuggerWillStopDueToInvalidBreakPoints(lines)) {
            this.outputBuffer = "";
        }
    }

    private processSuspendAndResume(lines: string[], lastLine: string, lastCmd: IJdbRunnerCommand) {
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
    }

    private processRunCommand(lines: string[], lastLine: string, lastCmd: IJdbRunnerCommand) {
        if (this.runCommandSent && !this.runCommandCompleted && lastCmd.type === JdbCommandType.Run) {
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
}
