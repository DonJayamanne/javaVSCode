import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

import * as child_process from 'child_process';
import {JdbRunner, JdbCommandType} from './jdb';
import {AttachRequestArguments, LaunchRequestArguments, IJavaEvaluationResult, IJavaStackFrame, IJavaThread, JavaEvaluationResultFlags, IDebugVariable, ICommand, IStackInfo} from './common/contracts';
const LineByLineReader = require('line-by-line');
const namedRegexp = require('named-js-regexp');
const ARRAY_ELEMENT_REGEX = new RegExp("^\\w+.*\\[[0-9]+\\]$");
interface IBreakpoint {
    className: string;
    line: number;
}
interface ICommandToExecute {
    name: string
    command?: string
    responseProtocol?: DebugProtocol.Response
}

class JavaDebugSession extends DebugSession {
    private registeredBreakpointsByFileName: Map<string, IBreakpoint[]>;
    private variableHandles: Handles<IDebugVariable>;
    private commands: ICommand[] = [];
    
    // Save packageName and currentFile path for future changes
    private currentFile: string;
    private packageName: string;

    public constructor(debuggerLinesStartAt1: boolean, isServer: boolean) {
        super(debuggerLinesStartAt1, isServer === true);
        this.variableHandles = new Handles<IDebugVariable>();
        this.registeredBreakpointsByFileName = new Map<string, IBreakpoint[]>();
        this.packageName = "";
        this.currentFile = "";
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        this.sendResponse(response);

        // now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
        this.sendEvent(new InitializedEvent());
    }

    private fileMapping = new Map<string, string>();
    private parseWhere(data: string): IStackInfo {
        if (data.indexOf("[") === -1) {
            return null;
        }
        var currentStack = <IStackInfo>{};
        var indexOfColon = data.lastIndexOf(":");
        var fileName = "";
        var line = "0";
        var fullFileName = "";
        var functionName = data.substring(data.indexOf("]") + 1, data.lastIndexOf("(")).trim();
        if (indexOfColon > 0 && functionName.indexOf("java.") !== 0) {
            fileName = data.substring(data.lastIndexOf("(") + 1, data.lastIndexOf(":"));
            line = data.substring(data.lastIndexOf(":") + 1, data.lastIndexOf(")"));
            fullFileName = fileName;
            if (this.fileMapping.has(fileName)) {
                fullFileName = this.fileMapping.get(fileName);
            }
            else {
                for (const sourceFolder of this.sourceFolders) {
                    const testfullFileName = path.join(sourceFolder, fileName);
                    if (fs.existsSync(testfullFileName)) {
                        fullFileName = testfullFileName;
                        this.fileMapping.set(fileName, fullFileName);
                        break;
                    } else {
                        //it is possibly a package
                        var index = functionName.lastIndexOf(".");
                        if (index > 0 && functionName.indexOf(".") < index) {
                            var packageName = functionName.substring(0, index);
                            packageName = path.basename(packageName, path.extname(packageName));
                            var packagePath = packageName.split(".").reduce((previousValue, currentValue) => path.join(previousValue, currentValue), "");
                            var packageFileName = path.join(sourceFolder, packagePath, fileName);
                            if (fs.existsSync(packageFileName)) {
                                this.fileMapping.set(fileName, packageFileName);
                                fullFileName = packageFileName;
                                break;
                            }
                        }
                    }
                }
            }
        }
        currentStack.fileName = fullFileName;
        currentStack.lineNumber = parseInt(line);
        currentStack["function"] = functionName;
        currentStack.source = data;
        return currentStack;
    }
    private jdbRunner: JdbRunner;
    private sourceFolders: string[];
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
            return 0;
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

    protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {
        // This seems to work for now. There is no specific configuration for attach, as JdbRunner handles both types of args
        this.launchRequest(response, args);
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        this.launchResponse = response;
        if (args.sourcePath) {
            this.sourceFolders = args.sourcePath;
        } else {
            this.sourceFolders = [args.cwd];
        }

        this.jdbRunner = new JdbRunner(args, this);

        this.jdbRunner.jdbLoaded.then(() => {
            //Ok, now get the thread id for this
            this.sendResponse(this.launchResponse);
            // this.sendEvent(new StoppedEvent("entry"));
        }).catch(error => {
            var message: DebugProtocol.Message = { id: -1, format: "", showUser: true };
            if (error instanceof Error) {
                message.format = error.name + ":" + error.message;
            }
            else {
                message.format = error + "";
            }
            this.sendErrorResponse(response, message);
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
            var threads = data.data;
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

    private setBreakPoint(classNames: string[], line: number): Promise<{ className: string, verified: boolean }> {
        return new Promise<any>((resolve, reject) => {
            if (classNames.length === 0) {
                return reject();
            }
            var className = classNames.pop();
            this.jdbRunner.sendCmd(`stop at ${className}:${line}`, JdbCommandType.SetBreakpoint).then(resp => {
                if (resp.data.length > 0 && resp.data[resp.data.length - 1].indexOf("Unable to set breakpoint") >= 0) {
                    return this.setBreakPoint(classNames, line);
                }
                else {
                    let verified = resp.data.some(value => value.indexOf("Set breakpoint") >= 0);
                    resolve({ className: className, verified: verified });
                }
            });
        });
    }

    private getPackageName(file: string) {
        let packageName = "", regex: RegExp, match: RegExpMatchArray;
        let data = fs.readFileSync(file);
        // Search package keyword inside java source and then extract packageName
        if (data.indexOf('package') >= 0) {
            regex = /package (.*);/g;
            match = regex.exec(data.toString());
            packageName = match[1];
        }
        return packageName;
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        this.jdbRunner.readyToAcceptBreakPoints.then(() => {
            // If currentFile name changes then packageName will be set by getPackageName.
            if (this.currentFile !== args.source.path) {
                this.currentFile = args.source.path;
                this.packageName = this.getPackageName(this.currentFile);
            }
            if (!this.registeredBreakpointsByFileName.has(this.currentFile)) {
                this.registeredBreakpointsByFileName.set(this.currentFile, []);
            }
            let linesWithBreakPointsForFile = this.registeredBreakpointsByFileName.get(this.currentFile);

            let className = path.basename(this.currentFile);
            className = className.substring(0, className.length - path.extname(className).length);
            // Add packageName to className only if packageName is found
            if (this.packageName.length > 0) {
                className = `${this.packageName}.${className}`;
            }
            //Add breakpoints for lines that are new
            let newBreakpoints = args.breakpoints.filter(bk => !linesWithBreakPointsForFile.some(item => item.line === bk.line));
            let addBreakpoints = newBreakpoints.map(bk => {
                return new Promise<{ threadName: string, line: number, verified: boolean }>(resolve => {
                    this.jdbRunner.sendCmd(`stop at ${className}:${bk.line}`, JdbCommandType.SetBreakpoint).then(resp => {
                        if (resp.data.length > 0 && resp.data.some(value => value.indexOf("Unable to set breakpoint") >= 0)) {
                            this.getClasseNames(this.currentFile, bk.line).then(classNames => {
                                this.setBreakPoint(classNames, bk.line)
                                    .then(bkResp => {
                                        //Keep track of this valid breakpoint
                                        linesWithBreakPointsForFile.push({ className: bkResp.className, line: bk.line });
                                        resolve({ threadName: resp.threadName, line: bk.line, verified: bkResp.verified });
                                    })
                                    .catch(() => resolve({ threadName: resp.threadName, line: bk.line, verified: false }));
                            });
                        }
                        else {
                            let verified = resp.data.some(value => value.indexOf("Set breakpoint") >= 0);
                            //Keep track of this valid breakpoint
                            linesWithBreakPointsForFile.push({ className: className, line: bk.line });
                            resolve({ threadName: resp.threadName, line: bk.line, verified: verified });
                        }
                    });
                });
            });

            //Add breakpoints for lines that are new
            let redundantBreakpoints = linesWithBreakPointsForFile.filter(bk => args.lines.indexOf(bk.line) === -1);
            let removeBreakpoints = redundantBreakpoints.map(bk =>
                this.jdbRunner.sendCmd(`clear ${bk.className}:${bk.line}`, JdbCommandType.ClearBreakpoint).then(() => null)
            );
            Promise.all(addBreakpoints.concat(removeBreakpoints)).then(values => {
                // send back the actual breakpoints
                response.body = {
                    breakpoints: []
                };

                //Re-build the list of valid breakpoints
                //remove the invalid list of breakpoints
                linesWithBreakPointsForFile = linesWithBreakPointsForFile.filter(bk => !redundantBreakpoints.some(rbk => rbk.line === bk.line));
                this.registeredBreakpointsByFileName.set(this.currentFile, linesWithBreakPointsForFile);

                //Return the breakpoints
                let unVerifiedBreakpoints = args.breakpoints.filter(bk => !linesWithBreakPointsForFile.some(verifiedBk => verifiedBk.line === bk.line));
                unVerifiedBreakpoints.forEach(bk => {
                    response.body.breakpoints.push({ verified: false, line: bk.line });
                });
                linesWithBreakPointsForFile.forEach(line => {
                    response.body.breakpoints.push({ verified: true, line: line.line });
                });

                this.sendResponse(response);
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
            if (data.length === 2 && !data[0].startsWith(variableName) && data[0].indexOf("Exception: ") >= 0) {
                throw data[0];
            }

            var variablePrintedValue = data.join("");
            return variablePrintedValue.substring(variablePrintedValue.indexOf(` ${variableName} = `) + ` ${variableName} = `.length);
        });
        var dumpPromise = this.jdbRunner.sendCmd("dump " + variableName, JdbCommandType.Dump).then(resp => {
            var data = resp.data;
            if (data.length === 0 || data[0].length === 0) {
                throw "Invalid";
            }
            if (data.length === 2 && !data[0].startsWith(variableName) && data[0].indexOf("Exception: ") >= 0) {
                throw data[0];
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
            }).catch(ex => {
                //swallow exception
                variables.variables.push({
                    StringRepr: ex,
                    ChildName: "",
                    ExceptionText: "",
                    Expression: variableName,
                    Flags: JavaEvaluationResultFlags.Raw,
                    Frame: null,
                    IsExpandable: false,
                    Length: 0,
                    TypeName: "string",
                    DumpRepr: ex,
                    DumpLines: [ex]
                });
            });
        });

        return Promise.all(promises).then(() => {
            scopes.push(new Scope(scopeName, this.variableHandles.create(variables), false));
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
    private getArrayValues(dumpRepr: string, parentExpression: string): any[] {
        //Split by commas
        var value = dumpRepr.trim().substring(1);
        value = value.substring(0, value.length - 1);
        return value.split(", ").map((item, index) => {
            var variable = <IJavaEvaluationResult>{
                StringRepr: item,
                ChildName: `[${index}]`,
                ExceptionText: "",
                Expression: `${parentExpression}[${index}]`,
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
                variablesReference = this.variableHandles.create(parentVariable);
            }

            return {
                name: variable.ChildName,
                value: variable.StringRepr,
                variablesReference: variablesReference
            };
        });
    }
    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        if (this.paused === true) {
            response.body = {
                variables: []
            };
            this.sendResponse(response);
            return;
        }
        var varRef = this.variableHandles.get(args.variablesReference);

        if (varRef.evaluateChildren === true) {
            var parentVariable = varRef.variables[0];
            if (this.isArray(parentVariable.StringRepr, parentVariable.DumpRepr)) {
                let variables = this.getArrayValues(parentVariable.DumpRepr, parentVariable.Expression);
                response.body = {
                    variables: variables
                };
                this.sendResponse(response);
            }
            else {
                if (!ARRAY_ELEMENT_REGEX.test(parentVariable.Expression)) {
                    //this.isComplexObject(parentVariable.DumpRepr) && parentVariable.StringRepr.indexOf("@") > 0) {
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
                            let isComplex = this.isComplexObject(values.printedValue) || this.isComplexObject(values.dumpValue);
                            let variable = <IJavaEvaluationResult>{
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
                                variablesReference = this.variableHandles.create(parentVariable);
                            }

                            variables.push({
                                name: variable.ChildName,
                                value: variable.StringRepr,
                                variablesReference: variablesReference
                            });
                        }).catch(ex => {
                            let variable = <IJavaEvaluationResult>{
                                StringRepr: ex,
                                ChildName: propertyName,
                                ExceptionText: "",
                                Expression: expr,
                                Flags: JavaEvaluationResultFlags.Raw,
                                Frame: null,
                                IsExpandable: false,
                                Length: 0,
                                TypeName: "string",
                                DumpRepr: ex,
                                DumpLines: [ex]
                            };
                            let variablesReference = 0;
                            //If this value can be expanded, then create a vars ref for user to expand it
                            if (variable.IsExpandable) {
                                const parentVariable: IDebugVariable = {
                                    variables: [variable],
                                    evaluateChildren: false
                                };
                                variablesReference = this.variableHandles.create(parentVariable);
                            }

                            variables.push({
                                name: variable.ChildName,
                                value: variable.StringRepr,
                                variablesReference: variablesReference
                            });
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
                else {
                    let variables = [];
                    this.getVariableValue(parentVariable.Expression).then(values => {
                        if (this.isArray(values.printedValue, values.dumpValue)) {
                            variables = this.getArrayValues(values.dumpValue, parentVariable.Expression);
                            return;
                        }

                        //TODO: Certain this is wrong and will need clean up (leaving for later due to lack of time)
                        //Worst case user will have to expan again (yuck, but works, till then TODO)
                        let isComplex = this.isComplexObject(values.printedValue) || this.isComplexObject(values.dumpValue);
                        let variable = <IJavaEvaluationResult>{
                            StringRepr: values.printedValue,
                            ChildName: parentVariable.Expression,
                            ExceptionText: "",
                            Expression: parentVariable.Expression,
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
                            variablesReference = this.variableHandles.create(parentVariable);
                        }

                        variables.push({
                            name: variable.ChildName,
                            value: variable.StringRepr,
                            variablesReference: variablesReference
                        });
                    }).catch(ex => {
                        //TODO: DRY
                        let variable = <IJavaEvaluationResult>{
                            StringRepr: ex,
                            ChildName: parentVariable.Expression,
                            ExceptionText: "",
                            Expression: parentVariable.Expression,
                            Flags: JavaEvaluationResultFlags.Raw,
                            Frame: null,
                            IsExpandable: false,
                            Length: 0,
                            TypeName: "string",
                            DumpRepr: ex,
                            DumpLines: [ex]
                        };
                        let variablesReference = 0;
                        //If this value can be expanded, then create a vars ref for user to expand it
                        if (variable.IsExpandable) {
                            const parentVariable: IDebugVariable = {
                                variables: [variable],
                                evaluateChildren: false
                            };
                            variablesReference = this.variableHandles.create(parentVariable);
                        }

                        variables.push({
                            name: variable.ChildName,
                            value: variable.StringRepr,
                            variablesReference: variablesReference
                        });
                    }).then(() => {
                        response.body = {
                            variables: variables
                        };
                        this.sendResponse(response);
                    });

                    return;
                }

                // response.body = {
                //     variables: []
                // };
                // this.sendResponse(response);
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
                    variablesReference = this.variableHandles.create(parentVariable);
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
        this.jdbRunner.jdbLoaded.then(() => {
            this.getVariableValue(args.expression).then(value => {
                var isComplex = this.isComplexObject(value.printedValue) || this.isComplexObject(value.dumpValue);
                let variables: IDebugVariable = { evaluateChildren: true, variables: [] };
                variables.variables.push({
                    StringRepr: value.printedValue,
                    ChildName: "",
                    ExceptionText: "",
                    Expression: args.expression,
                    Flags: isComplex ? JavaEvaluationResultFlags.Expandable : JavaEvaluationResultFlags.Raw,
                    Frame: null,
                    IsExpandable: isComplex,
                    Length: 0,
                    TypeName: "string",
                    DumpRepr: value.dumpValue,
                    DumpLines: value.dumpLines
                });

                response.body = {
                    result: value.printedValue,
                    variablesReference: isComplex ? this.variableHandles.create(variables) : 0
                };

                this.sendResponse(response);
            }).catch(error => {
                this.sendErrorResponse(response, 2000, error);
            });
        });
    }

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
