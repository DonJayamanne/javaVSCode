'use strict';

import * as path from 'path';
import * as settings from './../common/configSettings';
import {OutputChannel, window} from 'vscode';
import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { exec } from 'child_process';
import {sendCommand} from './../common/childProc';
const getport = require("get-port");
import {WaitForPortToOpen} from '../common/WaitForPortToOpen';

import * as net from 'net';
import * as logger from '../common/logger';

const COMPILER_MESSAGE_SEPARATOR = "0EC18C4E-E0E1-4C42-B325-366003E0D504";
const END_MARKER = "5EC18C4E-E0E1-4C42-B325-366003E0D505";
const CHARACTERS_TO_TRIM_FROM_MESSAGE: string[] = ["\\r\\n", "\r\n"];
const MILLISECONDS_WAIT_FOR_PORT_TO_OPEN = 5000;

export class CompilerServer {
    private javaProc: child_process.ChildProcess;
    private socket: net.Socket = null;
    private started;
    constructor(private rootDir: string, private javaSettings: settings.IJavaSettings, private outputChannel: OutputChannel) {
        this.fileCompilationCallbacks = [];
    }

    private getJavaCompilerClassPath(): string {
        var currentFileName = module.filename;
        var filePath = path.join(path.dirname(currentFileName), "..", "..", "..", "JavaFiles");
        return filePath;
    }

    private fileCompilationCallbacks: { resolve: (string) => void, reject: Function }[];
    public start(): Promise<any> {
        return getport().then((port: number) => {
            var processCwd = this.getJavaCompilerClassPath();
            var args = ["CompilerUtils", port.toString(), COMPILER_MESSAGE_SEPARATOR];
            var javaPath = this.javaSettings.jdkPath.length === 0 ? "java" : path.join(this.javaSettings.jdkPath, "java");
            this.javaProc = child_process.spawn(this.javaSettings.jdkPath, args, { cwd: processCwd });
            return Promise.all([port, WaitForPortToOpen(port, MILLISECONDS_WAIT_FOR_PORT_TO_OPEN)]);
        })
            .then(result => this.startClient(result[0]))
            .catch(error => {
                this.displayError("Failed to start/connect to Compiler Services", error);
                throw error;
            });
    }

    public startCompiling(compilerSettings: settings.ICompilerSettings, files: string[]): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.fileCompilationCallbacks.push({
                reject: reject,
                resolve: resolve
            });

            this.WriteString("STARTOPTIONS" + "\n");
            if (Array.isArray(compilerSettings.options)) {
                compilerSettings.options.forEach(option => {
                    if (option.indexOf("${workspaceRoot}") > 0) {
                        option = option.replace("${workspaceRoot}", vscode.workspace.rootPath);
                    }
                    this.WriteString(option.replace("${workspaceRoot}", vscode.workspace.rootPath) + "\n");
                });
            }
            this.WriteString("ENDOPTIONS" + "\n");

            this.WriteString("START" + "\n");
            files.forEach(file => {
                this.WriteString(file + "\n");
            });
            this.WriteString("END" + "\n");
        });
    }

    private WriteString(value: string) {
        var stringBuffer = new Buffer(value, "utf-8");
        if (stringBuffer.length > 0) {
            this.socket.write(stringBuffer);
        }
    }

    private startClient(portNumber: number): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            var that = this;
            var connected = false;
            var options = <any>{ port: portNumber };
            this.socket = net.connect(options, () => {
                connected = true;
                resolve(options);
            });

            var data = "";
            var numberOfCharactersToWaitFor = -1;
            var responsePrefix = "";
            this.socket.on("data", (buffer: Buffer) => {
                var currentData = buffer.toString();
                if (currentData.startsWith("ERRORS:") || currentData.startsWith("EXCEPTION:")) {
                    data = currentData;
                }
                else {
                    data = data + currentData;
                }

                CHARACTERS_TO_TRIM_FROM_MESSAGE.forEach(str => {
                    if (data.startsWith(str)) {
                        data = data.substring(str.length);
                    }
                    if (data.endsWith(str)) {
                        data = data.substring(0, data.length - str.length);
                    }
                });

                if (numberOfCharactersToWaitFor === -1) {
                    responsePrefix = data.substring(0, data.indexOf(":"));
                    switch (responsePrefix) {
                        case "ERRORS": {
                            //Now, look for the next semi colon
                            let lengthOfMessagePortion = data.substring("ERRORS:".length);
                            let nextIndex = lengthOfMessagePortion.indexOf(":");
                            if (nextIndex > 0) {
                                numberOfCharactersToWaitFor = parseInt(lengthOfMessagePortion.substring(0, nextIndex));
                            }
                            break;
                        }
                        case "EXCEPTION": {
                            //Now, look for the next semi colon
                            debugger;
                            let lengthOfMessagePortion = data.substring("EXCEPTION:".length);
                            let nextIndex = lengthOfMessagePortion.indexOf(":");
                            if (nextIndex > 0) {
                                numberOfCharactersToWaitFor = parseInt(lengthOfMessagePortion.substring(0, nextIndex));
                            }
                            break;
                        }
                        default: {
                            debugger;
                            this.displayError("Uknown response from Compiler Services");
                            logger.error("Uknown response from Compiler Services", data);
                            break;
                        }
                    }
                }
                if (numberOfCharactersToWaitFor === -1) {
                    return;
                }
                if (!data.endsWith(END_MARKER)) {
                    return;
                }

                var header = responsePrefix + ":" + numberOfCharactersToWaitFor + ":";
                //We have everytyhing we need
                var compilerResponse = data.substring(header.length, header.length + numberOfCharactersToWaitFor - END_MARKER.length);

                //Start processing the next message
                data = data.substring(header.length + compilerResponse.length);
                numberOfCharactersToWaitFor = -1;
                var item = this.fileCompilationCallbacks.pop();

                if (this.fileCompilationCallbacks.length === 0) {
                    if (responsePrefix === "ERRORS") {
                        item.resolve(compilerResponse);
                    }
                    else {
                        this.displayError(`Error in Compiler Services (${compilerResponse})`);
                        logger.error("Error in Compiler Services", compilerResponse);
                        item.resolve("");
                    }
                }
                else {
                    item.resolve("");
                }
            });
            this.socket.on("timeout", error => {
                this.displayError("Java Compiler timeout", error);
                if (!connected) {
                    reject();
                }
            });
            this.socket.on("error", error => {
                this.displayError("Failed to connect to Java Compiler", error);
                if (connected) {
                    throw error;
                }
                else {
                    reject();
                }
            });
        });
    }
    private displayError(message: string, error?: Error) {
        if (!message.endsWith(".")) {
            message += ".";
        }
        if (error && error.message) {
            message += ` (${error.message})`;
        }
        if (error && typeof error === "string") {
            message += ` (${error})`;
        }
        vscode.window.showErrorMessage(message);
    }
}