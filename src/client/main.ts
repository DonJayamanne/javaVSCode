'use strict';

import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as child_process from 'child_process';
import {JdbRunner, JdbCommandType} from './jdb';
import {LaunchRequestArguments, IJavaEvaluationResult, IJavaStackFrame, IJavaThread, JavaEvaluationResultFlags, IDebugVariable, ICommand, IStackInfo} from './common/contracts';
const LineByLineReader = require('line-by-line');
const namedRegexp = require('named-js-regexp');

interface ICommandToExecute {
    name: string
    command?: string
    responseProtocol?: DebugProtocol.Response
}

class JavaDebugSession extends DebugSession {

    private _variableHandles: Handles<IDebugVariable>;
    private commands: ICommand[] = [];
    private _sourceFile: string;
    private _breakPoints: any;


    public constructor(debuggerLinesStartAt1: boolean, isServer: boolean) {
        super(debuggerLinesStartAt1, isServer === true);
        this._sourceFile = null;
        this._breakPoints = {};
        this._variableHandles = new Handles<IDebugVariable>();
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        this.sendResponse(response);

        // now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
        this.sendEvent(new InitializedEvent());
    }

    private validFiles = {};
    private parseWhere(data: string): IStackInfo {
        if (data.indexOf("[") === -1) {
            return null;
        }
        var currentStack = <IStackInfo>{};
        var indexOfColon = data.lastIndexOf(":");
        var fileName = "";
        var line = "0";
        var fullFileName = "";
        if (indexOfColon > 0) {
            fileName = data.substring(data.lastIndexOf("(") + 1, data.lastIndexOf(":"));
            line = data.substring(data.lastIndexOf(":") + 1, data.lastIndexOf(")"));
            fullFileName = fileName;
            if (this.validFiles[fileName]) {
                fullFileName = path.join(this.rootDir, fileName);
            }
            else {
                fullFileName = path.join(this.rootDir, fileName);
                if (fs.existsSync(fullFileName)) {
                    this.validFiles[fileName] = true;
                }
                else {
                    fullFileName = fileName === "null" ? "" : fileName;
                }
            }
        }
        currentStack.fileName = fullFileName;
        currentStack.lineNumber = parseInt(line);
        currentStack["function"] = data.substring(data.indexOf("]") + 1, data.lastIndexOf("(")).trim();
        currentStack.source = data;
        return currentStack;
    }
    private jdbRunner: JdbRunner;
    private rootDir: string;
    private launchResponse: DebugProtocol.LaunchResponse;
    private threads: IJavaThread[];
    private getThreadId(name: string): Promise<number> {
        if (this.threads && this.threads.length > 0) {
            var thread = this.threads.filter(t => t.Name === name);
            if (thread.length > 0) {
                return Promise.resolve(thread[0].Id);
            }
        }

        return this.getThreads().then(threads => {
            this.threads = threads;
            var thread = this.threads.filter(t => t.Name === name);
            if (thread.length > 0) {
                return thread[0].Id;
            }
            var thread = this.threads.filter(t => t.Name.indexOf(name) === 0);
            if (thread.length > 0) {
                return thread[0].Id;
            }

            //Error
            debugger;
            return 1;
        });
    }

    private findThread(name: string, threads: IJavaThread[] = this.threads): IJavaThread {
        var thread = threads.filter(t => t.Name === name);
        if (thread.length > 0) {
            return thread[0];
        }
        var thread = this.threads.filter(t => t.Name.indexOf(name) === 0);
        if (thread.length > 0) {
            return thread[0];
        }

        return null;
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        this._sourceFile = args.program;
        this.launchResponse = response;
        this.rootDir = path.dirname(this._sourceFile);

        this.jdbRunner = new JdbRunner(this._sourceFile, args, this);

        this.jdbRunner.jdbLoaded.then(() => {
            //Ok, now get the thread id for this
            this.sendResponse(this.launchResponse);
            // this.sendEvent(new StoppedEvent("entry"));
        });

        this.jdbRunner.Exited.then(() => {
            this.sendEvent(new TerminatedEvent());
        });

        this.jdbRunner.addListener("breakpointHit", threadName => {
            this.handleBreakPointHit(threadName);
        });
        this.jdbRunner.addListener("debuggerStopInvalidBreakPoints", threadName => {
            this.handleBreakPointHit(threadName, "invalidBreakPoint");
        });
    }

    private getThreads(): Promise<IJavaThread[]> {
        return this.jdbRunner.sendCmd("threads", JdbCommandType.ListThreads).then(data => {
            // var index = data.data.indexOf("Group main:");
            // if (index === -1 || index + 1 >= data.data.length) {
            //     return [];
            // }

            var threads = data.data;//.splice(index + 1);
            return threads.map(info => {
                info = info.trim();
                if (info.endsWith(":") && info.indexOf("[") === -1) {
                    return null;
                }
                var REGEX = '(?<crap>(\.*))(?<id>0x[0-9A-Fa-f]*)\s*(?<name>.*)';
                var namedRegexp = require('named-js-regexp');
                var rawMatch = namedRegexp(REGEX, "g").exec(info);
                if (rawMatch === null) {
                    return null;
                }
                else {
                    var groups = rawMatch.groups();
                    var name = groups.name.trim();
                    var items = name.split(" ").filter(value => value.trim().length > 0);
                    var status = items[items.length - 1];
                    if (name.indexOf("cond. waiting") === name.length - "cond. waiting".length) {
                        name = name.substring(0, name.length - "cond. waiting".length).trim();
                        status = "waiting";
                    }
                    else {
                        if (name.indexOf("running (at breakpoint)") === name.length - "running (at breakpoint)".length) {
                            name = name.substring(0, name.length - "running (at breakpoint)".length).trim();
                            status = "running";
                        }
                        else {
                            name = name.substring(0, name.length - status.length).trim();
                        }
                    }
                    var t: IJavaThread = { Frames: [], Id: parseInt(groups.id), HexId: <string>groups.id, Name: <string>name };
                    return t;
                }
            }).filter(t => t !== null);
        });
    }

    private getClasseNames(filePath: string, maxLineNumber: number): Promise<string[]> {
        return new Promise<boolean>((resolve, reject) => {
            fs.exists(filePath, exists => {
                if (exists) {
                    resolve();
                }
                else {
                    reject();
                }
            });
        }).then(() => {
            return new Promise<string[]>((resolve, reject) => {
                var lr = new LineByLineReader(filePath);
                var shebangLines: string[] = [];
                var classNames: string[] = [];
                var lineNumber = 0;
                lr.on('error', err => {
                    resolve(classNames);
                });
                lr.on('line', (line: string) => {
                    lineNumber++;
                    if (lineNumber > maxLineNumber) {
                        lr.close();
                        return false;
                    }

                    var REGEX = '.*(?<class>(class))\\s*(?<name>\\w*)\\s*.*';
                    var rawMatch = namedRegexp(REGEX, "g").exec(line);
                    if (rawMatch) {
                        var name = <string>rawMatch.groups().name.trim();
                        if (name.length > 0) {
                            classNames.push(name);
                        }
                    }
                });
                lr.on('end', function () {
                    resolve(classNames);
                });
            });
        }).catch(() => {
            return [];
        });
    }

    private setBreakPoint(classNames: string[], line: number): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            if (classNames.length === 0) {
                return reject();
            }
            var className = classNames.pop();
            this.jdbRunner.sendCmd(`stop at ${className}:${line}`, JdbCommandType.SetBreakPoint).then(resp => {
                if (resp.data.length > 0 && resp.data[resp.data.length - 1].indexOf("Unable to set breakpoint") >= 0) {
                    return this.setBreakPoint(classNames, line);
                }
                else {
                    resolve();
                }
            });
        });
    }
    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        this.jdbRunner.readyToAcceptBreakPoints.then(() => {
            var className = path.basename(args.source.path);
            className = className.substring(0, className.length - path.extname(className).length);
            var promises = args.breakpoints.map(bk => {
                return new Promise<{ threadName: string, line: number, verified: boolean }>(resolve => {
                    this.jdbRunner.sendCmd(`stop at ${className}:${bk.line}`, JdbCommandType.SetBreakPoint).then(resp => {
                        if (resp.data.length > 0 && resp.data.some(value => value.indexOf("Unable to set breakpoint") >= 0)) {
                            this.getClasseNames(args.source.path, bk.line).then(classNames => {
                                this.setBreakPoint(classNames, bk.line).then(() =>
                                    resolve({ threadName: resp.threadName, line: bk.line, verified: true })
                                ).catch(() =>
                                    resolve({ threadName: resp.threadName, line: bk.line, verified: false })
                                    );
                            });
                        }
                        else {
                            resolve({ threadName: resp.threadName, line: bk.line, verified: true });
                        }
                    });
                });
            });
            Promise.all(promises).then(verifiedLines => {
                // send back the actual breakpoints
                response.body = {
                    breakpoints: []
                };
                verifiedLines.forEach(line => {
                    response.body.breakpoints.push({ verified: <boolean>(<any>line).verified, line: <number>(<any>line).line });
                });

                // var threadName = (<any>verifiedLines[0]).threadName;
                // this.getThreadId(threadName).then(id => {
                this.sendResponse(response);
                // this.sendEvent(new StoppedEvent("breakpoint", id));
                // });
            });
        });
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        var threads = [];
        response.body = {
            threads: threads
        };
        if (!this.jdbRunner.readyToAcceptCommands) {
            this.sendResponse(response);
            return
        }

        this.jdbRunner.jdbLoaded.then(() => {
            this.getThreads().then(javaThreads => {
                javaThreads.forEach(t => {
                    threads.push(new Thread(t.Id, t.Name));
                });
                this.sendResponse(response);
            });
        });

    }

    private parseStackTrace(data: string[]): IStackInfo[] {
        var stackInfo: IStackInfo[] = [];
        data.forEach(line => {
            if (line.trim().length > 0 && line.indexOf(":") > 0 && line.indexOf("(") > 0) {
                var stack = this.parseWhere(line);
                if (stack) {
                    stackInfo.push(stack);
                }
            }
        });

        return stackInfo;
    }

    private refreshStackInfo: boolean = true;

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        if (!this.jdbRunner.readyToAcceptCommands) {
            return
        }

        this.determineWhereAll().then(threads => {
            response.body = {
                stackFrames: []
            };

            //Find the threadName
            var filteredThreads = threads.filter(t => t.Id === args.threadId);
            if (filteredThreads.length === 1) {
                response.body.stackFrames = filteredThreads[0].Frames;
            }
            this.sendResponse(response);
        });
    }

    private determineWhereAll(): Promise<IJavaThread[]> {
        return this.jdbRunner.jdbLoaded.then(() => {
            var whereAllPromise = this.jdbRunner.sendCmd("where all", JdbCommandType.ListStack).then(resp => {
                var whereAll = resp.data;
                var currentThread: IJavaThread = null;

                //check if we have any stacks for threads that we don't know about
                var missingThreadCount = whereAll.filter(where => {
                    where = where.trim();
                    if (!where.startsWith("[") && where.endsWith(":")) {
                        var threadName = where.substring(0, where.length - 1);
                        currentThread = this.findThread(threadName);
                        return currentThread === null;
                    }
                    return false;
                }).length;

                var getThreadsPromise = Promise.resolve(this.threads);
                if (missingThreadCount > 0) {
                    getThreadsPromise = this.getThreads();
                }

                return getThreadsPromise.then(threads => {
                    //Clear all of the previous stacks if there are any
                    threads.forEach(t => t.Frames = []);

                    whereAll.forEach(where => {
                        where = where.trim();
                        if (!where.startsWith("[") && where.endsWith(":")) {
                            var threadName = where.substring(0, where.length - 1);
                            currentThread = this.findThread(threadName, threads);
                            return;
                        }
                        if (currentThread === null) {
                            return;
                        }
                        var stackInfo = this.parseWhere(where);
                        if (stackInfo === null) {
                            return;
                        }
                        var i = currentThread.Frames.length;
                        var name = stackInfo.function;
                        currentThread.Frames.push(new StackFrame(i, `${name}(${i})`,
                            new Source(stackInfo.fileName, stackInfo.fileName.length === 0 ? "" : this.convertDebuggerPathToClient(stackInfo.fileName)),
                            stackInfo.lineNumber === 0 ? 0 : this.convertDebuggerLineToClient(stackInfo.lineNumber - 1),
                            0));
                    });

                    return threads;
                });
            });
            return whereAllPromise;
        });
    }

    private getVariableValue(variableName: string): Promise<{ printedValue: string, dumpValue: string, dumpLines: string[] }> {
        var printedPromise = this.jdbRunner.sendCmd("print " + variableName, JdbCommandType.Print).then(resp => {
            var data = resp.data;
            if (data.length === 0 || data[0].length === 0) {
                throw "Invalid";
            }
            if (data.length === 2 && !data[0].startsWith(variableName) && data[0].indexOf("ParseException: Name unknown: ") >= 0) {
                throw "Invalid";
            }

            var variablePrintedValue = data.join("");
            return variablePrintedValue.substring(variablePrintedValue.indexOf(` ${variableName} = `) + ` ${variableName} = `.length);
        });
        var dumpPromise = this.jdbRunner.sendCmd("dump " + variableName, JdbCommandType.Dump).then(resp => {
            var data = resp.data;
            if (data.length === 0 || data[0].length === 0) {
                throw "Invalid";
            }
            if (data.length === 2 && !data[0].startsWith(variableName) && data[0].indexOf("ParseException: Name unknown: ") >= 0) {
                throw "Invalid";
            }

            data[0] = data[0].substring(data[0].indexOf(` ${variableName} = `) + ` ${variableName} = `.length);
            return [data.join(""), data];
        });

        return Promise.all([printedPromise, dumpPromise]).then(values => {
            var stringValues = <any[]><any>values;
            return { printedValue: stringValues[0], dumpValue: stringValues[1][0], dumpLines: <string[]><any>values[1][1] };
        });
    }
    private variablesRefId: number;
    private isComplexObject(value: string): boolean {
        value = value.trim();
        return (value.startsWith("{") && value.endsWith("}")) ||
            (value.startsWith("instance of ") && value.indexOf("]") > value.indexOf("["));
    }
    private isArray(printValue: string, value: string): boolean {
        if ((value.startsWith("{") && value.endsWith("}")) &&
            (printValue.trim().startsWith("instance of ") && printValue.indexOf("]") > printValue.indexOf("["))) {
            return printValue.substring(printValue.lastIndexOf("]") + 1).trim().startsWith("(");
        }

        return false;
    }
    private addScopeAndVariables(scopes: DebugProtocol.Scope[], scopeName: string, values: string[]): Promise<any> {
        let variables: IDebugVariable = { evaluateChildren: false, variables: [] };
        var promises = values.map(argAndValue => {
            if (argAndValue.indexOf(" = ") === -1) {
                return Promise.resolve();
            }

            var variableName = argAndValue.substring(0, argAndValue.indexOf("=")).trim();
            return this.getVariableValue(variableName).then(value => {
                var isComplex = this.isComplexObject(value.printedValue) || this.isComplexObject(value.dumpValue);
                variables.variables.push({
                    StringRepr: value.printedValue,
                    ChildName: "",
                    ExceptionText: "",
                    Expression: variableName,
                    Flags: isComplex ? JavaEvaluationResultFlags.Expandable : JavaEvaluationResultFlags.Raw,
                    Frame: null,
                    IsExpandable: isComplex,
                    Length: 0,
                    TypeName: "string",
                    DumpRepr: value.dumpValue,
                    DumpLines: value.dumpLines
                });
            }).catch(() => {
                //swallow exception
                return "";
            });
        });

        return Promise.all(promises).then(() => {
            scopes.push(new Scope(scopeName, this._variableHandles.create(variables), false));
        });
    }
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        this.jdbRunner.jdbLoaded.then(() => {
            var scopes: DebugProtocol.Scope[] = [];
            response.body = { scopes };
            this.jdbRunner.sendCmd("locals", JdbCommandType.Locals).then(resp => {
                var data = resp.data;
                if (data.length === 0 || data.length === 1) {
                    this.sendResponse(response);
                    return;
                }

                //Parse the variables
                var startIndexOfMethodArgs = data.findIndex(line => line.endsWith("Method arguments:"));
                var startIndexOfLocalVariables = data.findIndex(line => line.endsWith("Local variables:"));

                var argsPromise = Promise.resolve();
                if (startIndexOfMethodArgs >= 0) {
                    var args = data.filter((line, index) => index >= startIndexOfMethodArgs && index < startIndexOfLocalVariables);
                    argsPromise = this.addScopeAndVariables(scopes, "Arguments", args);
                }

                var varsPromise = Promise.resolve();
                if (startIndexOfLocalVariables >= 0) {
                    var args = data.filter((line, index) => index >= startIndexOfLocalVariables);
                    varsPromise = this.addScopeAndVariables(scopes, "Locals", args);
                }

                Promise.all([argsPromise, varsPromise]).then(() => this.sendResponse(response));
            });
        });
    }

    private lastRequestedVariableId: string;
    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        if (this.paused === true) {
            response.body = {
                variables: []
            };
            this.sendResponse(response);
            return;
        }
        var varRef = this._variableHandles.get(args.variablesReference);

        if (varRef.evaluateChildren === true) {
            var parentVariable = varRef.variables[0];
            if (this.isArray(parentVariable.StringRepr, parentVariable.DumpRepr)) {
                //Split by commas
                var value = parentVariable.DumpRepr.trim().substring(1);
                value = value.substring(0, value.length - 1);
                let variables = [];
                value.split(", ").forEach((item, index) => {
                    var variable = <IJavaEvaluationResult>{
                        StringRepr: item,
                        ChildName: `[${index}]`,
                        ExceptionText: "",
                        Expression: `${parentVariable.Expression}[${index}]`,
                        Flags: this.isComplexObject(item) ? JavaEvaluationResultFlags.Expandable : JavaEvaluationResultFlags.Raw,
                        Frame: null,
                        IsExpandable: this.isComplexObject(item),
                        Length: 0,
                        TypeName: "string",
                        DumpRepr: item,
                        DumpLines: []
                    };
                    let variablesReference = 0;
                    //If this value can be expanded, then create a vars ref for user to expand it
                    if (variable.IsExpandable) {
                        const parentVariable: IDebugVariable = {
                            variables: [variable],
                            evaluateChildren: true
                        };
                        variablesReference = this._variableHandles.create(parentVariable);
                    }

                    variables.push({
                        name: variable.ChildName,
                        value: variable.StringRepr,
                        variablesReference: variablesReference
                    });
                });
                response.body = {
                    variables: variables
                };
                this.sendResponse(response);
            }
            else {
                if (this.isComplexObject(parentVariable.DumpRepr) && parentVariable.StringRepr.indexOf("@") > 0) {
                    let variables = [];
                    var promises = parentVariable.DumpLines.map(propertyLine => {
                        if (propertyLine.trim().length === 1) {
                            return Promise.resolve();
                        }
                        var propertyName = propertyLine.substring(0, propertyLine.indexOf(":")).trim();
                        propertyName = propertyName.substring(propertyName.lastIndexOf(".") + 1).trim();
                        var value = propertyLine.substring(propertyLine.indexOf(":") + 2);

                        var expr = `${parentVariable.Expression}.${propertyName}`;
                        return this.getVariableValue(expr).then(values => {
                            var isComplex = this.isComplexObject(values.printedValue) || this.isComplexObject(values.dumpValue);
                            var variable = <IJavaEvaluationResult>{
                                StringRepr: values.printedValue,
                                ChildName: propertyName,
                                ExceptionText: "",
                                Expression: expr,
                                Flags: isComplex ? JavaEvaluationResultFlags.Expandable : JavaEvaluationResultFlags.Raw,
                                Frame: null,
                                IsExpandable: isComplex,
                                Length: 0,
                                TypeName: "string",
                                DumpRepr: values.dumpValue,
                                DumpLines: values.dumpLines
                            };
                            let variablesReference = 0;
                            //If this value can be expanded, then create a vars ref for user to expand it
                            if (variable.IsExpandable) {
                                const parentVariable: IDebugVariable = {
                                    variables: [variable],
                                    evaluateChildren: true
                                };
                                variablesReference = this._variableHandles.create(parentVariable);
                            }

                            variables.push({
                                name: variable.ChildName,
                                value: variable.StringRepr,
                                variablesReference: variablesReference
                            });
                        }).catch(() => {
                            return "";
                        });
                    });

                    Promise.all(promises).then(() => {
                        response.body = {
                            variables: variables
                        };
                        this.sendResponse(response);
                    });

                    return;
                }

                response.body = {
                    variables: []
                };
                this.sendResponse(response);
            }
        }
        else {
            let variables = [];
            varRef.variables.forEach(variable => {
                let variablesReference = 0;
                //If this value can be expanded, then create a vars ref for user to expand it
                if (variable.IsExpandable) {
                    const parentVariable: IDebugVariable = {
                        variables: [variable],
                        evaluateChildren: true
                    };
                    variablesReference = this._variableHandles.create(parentVariable);
                }

                variables.push({
                    name: variable.Expression,
                    value: variable.StringRepr,
                    variablesReference: variablesReference
                });
            });

            response.body = {
                variables: variables
            };

            return this.sendResponse(response);
        }
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse): void {
        if (!this.jdbRunner.readyToAcceptCommands) {
            return
        }
        if (this.paused === true) {
            this.sendErrorResponse(response, 2000, "Command unsupported while threads have been suspended/paused");
            return;
        }
        this.sendResponse(response);
        this.jdbRunner.sendCmd("step", JdbCommandType.Step).then(resp => {
            this.getThreadId(resp.threadName).then(id => {
                this.sendEvent(new StoppedEvent("step", id));
            });
        });
    }

    protected stepOutRequest(response: DebugProtocol.StepInResponse): void {
        if (this.paused === true) {
            this.sendErrorResponse(response, 2000, "Command unsupported while threads have been suspended/paused");
            return;
        }
        this.sendResponse(response);
        this.jdbRunner.sendCmd("step up", JdbCommandType.StepUp).then(resp => {
            this.getThreadId(resp.threadName).then(id => {
                this.sendEvent(new StoppedEvent("step up", id));
            });
        });
    }

    private handleBreakPointHit(threadName: string, eventName: string = "breakpoint") {
        this.getThreadId(threadName).then(id => {
            this.sendEvent(new StoppedEvent(eventName, id));
        });
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        this.sendResponse(response);
        this.jdbRunner.sendCmd("exit", JdbCommandType.Exit);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this.sendResponse(response);
        var cmd = "";
        var cmdType: JdbCommandType;
        if (this.paused) {
            cmd = "resume";
            cmdType = JdbCommandType.Resume;
        }
        else {
            cmd = "cont";
            cmdType = JdbCommandType.Continue;
        }
        this.jdbRunner.sendCmd(cmd, cmdType).then(() => {
            this.paused = false;
        });;
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        if (this.paused === true) {
            this.sendErrorResponse(response, 2000, "Command unsupported while threads have been suspended/paused");
            return;
        }
        this.sendResponse(response);
        this.jdbRunner.sendCmd("next", JdbCommandType.Next).then(resp => {
            this.getThreadId(resp.threadName).then(id => {
                this.sendEvent(new StoppedEvent("next", id));
            });
        });
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        this.sendErrorResponse(response, 2000, "Evaluating expressions is not yet supported");
    }

    //Unsupported features 
    private paused: boolean;
    protected pauseRequest(response: DebugProtocol.PauseResponse): void {
        this.sendResponse(response);
        this.jdbRunner.sendCmd("suspend", JdbCommandType.Suspend).then(resp => {
            this.paused = true;
            this.getThreadId(resp.threadName).then(id => {
                this.sendEvent(new StoppedEvent("suspend", id));
            });
        });
    }

    protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {
        // console.error('Not yet implemented: setExceptionBreakPointsRequest');
        this.sendErrorResponse(response, 2000, "ExceptionBreakPointsRequest is not yet supported");
    }

}

DebugSession.run(JavaDebugSession);
