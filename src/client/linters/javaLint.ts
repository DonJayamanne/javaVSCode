'use strict';

import {OutputChannel, window, Range, Uri, workspace, TextDocument} from 'vscode';
import * as settings from './../common/configSettings';
import {CompilerServer} from './compilerServer';
import * as logger from '../common/logger';
import {translateCharacterPositionsToPositions} from '../common/lineUtils';


const COMPILER_MESSAGE_SEPARATOR = "0EC18C4E-E0E1-4C42-B325-366003E0D504";
const CHARACTERS_TO_TRIM_FROM_MESSAGE: string[] = ["\\r\\n", "\r\n"];
enum LineType { CODE, KIND, POSITION, LINE, START, END, SOURCE, MESSAGE }
export interface ILintMessage {
    range: Range
    code: string
    message: string
    possibleWord?: string
    type: string
    severity?: LintMessageSeverity
    provider: string
    fileUri: Uri
}
interface ILintMessageExtended extends ILintMessage { start: number; end: number; line: number; }

export enum LintMessageSeverity { Hint, Error, Warning, Information }

const prefixTypeMapping = new Map<string, LineType>();
prefixTypeMapping.set("CODE", LineType.CODE);
prefixTypeMapping.set("END", LineType.END);
prefixTypeMapping.set("KIND", LineType.KIND);
prefixTypeMapping.set("LINE", LineType.LINE);
prefixTypeMapping.set("MESSAGE", LineType.MESSAGE);
prefixTypeMapping.set("POSITION", LineType.POSITION);
prefixTypeMapping.set("SOURCE", LineType.SOURCE);
prefixTypeMapping.set("START", LineType.START);

const severityMapping = new Map<string, LintMessageSeverity>();
severityMapping.set("ERROR", LintMessageSeverity.Error);
severityMapping.set("MANDATORY_WARNING", LintMessageSeverity.Warning);
severityMapping.set("NOTE", LintMessageSeverity.Information);
severityMapping.set("OTHER", LintMessageSeverity.Information);
severityMapping.set("WARNING", LintMessageSeverity.Warning);

export class Linter {
    private compiler: CompilerServer;
    private Id: string;
    private fileList: Map<string, string>;
    private fileLoadingPromise: Thenable<any>;
    private compileSpecificFiles: boolean;
    private previouslyIdentifiedFiles: string[];
    constructor(private rootDir: string, private javaSettings: settings.IJavaSettings, private outputChannel: OutputChannel) {
        this.Id = "java";
        this.compiler = new CompilerServer(rootDir, javaSettings, outputChannel);
        this.fileList = new Map<string, string>();
        this.checkIfRequiredIterateJavaFiles();
        workspace.onDidChangeConfiguration(() => this.checkIfRequiredIterateJavaFiles());
    }

    private checkIfRequiredIterateJavaFiles() {
        if (this.javaSettings.compiler.files.length >= 1) {
            this.compileSpecificFiles = true;
            this.fileLoadingPromise = Promise.resolve();
            this.previouslyIdentifiedFiles = null;
            return;
        }

        this.compileSpecificFiles = false;
        //If no files defined, then compile everything        
        this.fileLoadingPromise = workspace.findFiles("**/*.java", "").then(files => {
            files.forEach(file => {
                this.fileList.set(file.fsPath, file.fsPath);
            });

            var watcher = workspace.createFileSystemWatcher("**/*.java", false, false, false);
            watcher.onDidCreate(fileUri => {
                if (!this.fileList.has(fileUri.fsPath)) {
                    this.fileList.set(fileUri.fsPath, fileUri.fsPath);
                }
            });
            watcher.onDidDelete(fileUri => {
                if (this.fileList.has(fileUri.fsPath)) {
                    this.fileList.delete(fileUri.fsPath);
                }
            });
        });
    }

    private compilerStarted: Promise<any>;
    public runLinter(filePath: string, document: TextDocument): Promise<ILintMessage[]> {
        if (!this.javaSettings.linting.enabled) {
            return Promise.resolve([]);
        }

        this.compilerStarted = this.compilerStarted || this.compiler.start();

        return Promise.all([this.compilerStarted, this.fileLoadingPromise]).then(() => {
            var files = this.getFilesToCompile(filePath);
            return this.compiler.startCompiling(this.javaSettings.compiler, files);
        }).then(response => {
            return this.processFileCompilationCallback(response);
        }).catch(error => {
            window.showErrorMessage(`Linter failed (${error.message})`);
            throw error;
        });
    }

    private getFilesToCompile(currentFile: string): string[] {
        if (this.compileSpecificFiles) {
            return this.javaSettings.compiler.files.map(file => {
                return file === "${file}" ? currentFile : file;
            });
        }
        else {
            var files = [];
            this.fileList.forEach(file => files.push(file));
            return files;
        }
    }

    private processFileCompilationCallback(data: string): Promise<ILintMessage[]> {
        if (data.length === 0) {
            return Promise.resolve([]);
        }
        var outputLines = data.split(/0EC18C4E-E0E1-4C42-B325-366003E0D504/g);
        var diagnostics: ILintMessageExtended[] = [];
        var processingLine: LineType = LineType.CODE;
        var source = "";
        for (var counter = 0; counter < outputLines.length; counter++) {
            var lineContents = outputLines[counter];
            if (lineContents.indexOf(":") > 0) {
                var prefix = lineContents.substring(0, lineContents.indexOf(":"));
                if (prefixTypeMapping.has(prefix)) {
                    processingLine = prefixTypeMapping.get(prefix);
                    lineContents = lineContents.substring(prefix.length + 1);
                }

                //Ok, we're starting something new, reset the variables
                if (processingLine === LineType.CODE) {
                    source = "";
                    diagnostics.push(<ILintMessageExtended>{ provider: this.Id });
                }
            }

            var lastLintMessage: ILintMessageExtended = diagnostics[diagnostics.length - 1];
            switch (processingLine) {
                case LineType.CODE: {
                    lastLintMessage.code = lineContents;
                    break;
                }
                case LineType.KIND: {
                    lastLintMessage.type = lineContents;
                    if (severityMapping.has(lastLintMessage.type)) {
                        lastLintMessage.severity = severityMapping.get(lastLintMessage.type);
                    }
                    else {
                        lastLintMessage.severity = LintMessageSeverity.Error;
                    }
                    break;
                }
                case LineType.POSITION: {
                    //position = parseInt(lineContents);
                    break;
                }
                case LineType.LINE: {
                    //Remember, we need the zero based line numbers (index)
                    lastLintMessage.line = parseInt(lineContents) - 1;
                    break;
                }
                case LineType.START: {
                    lastLintMessage.start = parseInt(lineContents);
                    break;
                }
                case LineType.END: {
                    lastLintMessage.end = parseInt(lineContents);
                    break;
                }
                case LineType.SOURCE: {
                    if (lineContents.startsWith("RegularFileObject[") && lineContents.endsWith("]")) {
                        source = lineContents.substring("RegularFileObject[".length);
                        source = source.substring(0, source.length - 1);
                    }
                    else {
                        source = "";
                    }
                    break;
                }
                case LineType.MESSAGE: {
                    if (typeof lastLintMessage.message === "string") {
                        lastLintMessage.message += "\n" + lineContents;
                    }
                    else {
                        lastLintMessage.message = lineContents;
                    }
                    break;
                }
            }
            if (processingLine === LineType.MESSAGE) {
                if (source.length === 0) { continue; }

                lastLintMessage.fileUri = Uri.file(source);
            }
        }

        //Group all messages by the files
        var files: string[] = [];
        diagnostics.forEach(msg => {
            if (files.indexOf(msg.fileUri.fsPath) === -1) { files.push(msg.fileUri.fsPath); }
        });

        //For all errors in a file, ensure we translate the positions to vscode positions
        //Java compiler returns the positions within the file as character offset (yes we have line numbers, but that's only for the start)
        var promises = files.map(fileWithErrors => {
            var charIndexes = [];
            var fileErrors = diagnostics.filter(msg => msg.fileUri.fsPath === fileWithErrors);

            fileErrors.forEach(msg => {
                if (charIndexes.indexOf(msg.start) === -1) { charIndexes.push(msg.start); }
                if (charIndexes.indexOf(msg.end) === -1) { charIndexes.push(msg.end); }
            });

            return translateCharacterPositionsToPositions(fileWithErrors, charIndexes).then(positions => {
                fileErrors.forEach(msg => {
                    msg.range = new Range(positions.get(msg.start), positions.get(msg.end));
                });
            });
        });

        return Promise.all(promises).then(() => {
            return <ILintMessage[]>(<any>diagnostics);
        });
    }
}