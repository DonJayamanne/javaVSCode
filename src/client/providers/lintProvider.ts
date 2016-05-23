/*---------------------------------------------------------
 ** Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as javaLint from './../linters/javaLint';
import * as settings from '../common/configSettings';

const LINT_DELAY_MILLI_SECONDS = 100;
const FILE_PROTOCOL = "file:///"

const lintSeverityToVSSeverity = new Map<javaLint.LintMessageSeverity, vscode.DiagnosticSeverity>();
lintSeverityToVSSeverity.set(javaLint.LintMessageSeverity.Error, vscode.DiagnosticSeverity.Error)
lintSeverityToVSSeverity.set(javaLint.LintMessageSeverity.Hint, vscode.DiagnosticSeverity.Hint)
lintSeverityToVSSeverity.set(javaLint.LintMessageSeverity.Information, vscode.DiagnosticSeverity.Information)
lintSeverityToVSSeverity.set(javaLint.LintMessageSeverity.Warning, vscode.DiagnosticSeverity.Warning)

function createDiagnostics(message: javaLint.ILintMessage): vscode.Diagnostic {
    var severity = lintSeverityToVSSeverity.get(message.severity);
    return new vscode.Diagnostic(message.range, message.code + ":" + message.message, severity);
}

export class LintProvider extends vscode.Disposable {
    private settings: settings.IJavaSettings;
    private diagnosticCollection: vscode.DiagnosticCollection;
    private linter: javaLint.Linter;
    private pendingLintings = new Map<string, vscode.CancellationTokenSource>();
    private outputChannel: vscode.OutputChannel;
    private context: vscode.ExtensionContext;
    public constructor(context: vscode.ExtensionContext, settings: settings.IJavaSettings, outputChannel: vscode.OutputChannel) {
        super(() => { });
        this.outputChannel = outputChannel;
        this.context = context;
        this.settings = settings;

        this.initialize();
    }

    private initialize() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection("java");
        var disposables = [];

        this.linter = new javaLint.Linter(this.context.asAbsolutePath("."), this.settings, this.outputChannel);
        var disposable = vscode.workspace.onDidSaveTextDocument((e) => {
            if (e.languageId !== "java" || !this.settings.linting.enabled) {
                return;
            }
            this.lintDocument(e, LINT_DELAY_MILLI_SECONDS);
        });
        this.context.subscriptions.push(disposable);
    }

    private lastTimeout: number;
    private lintDocument(document: vscode.TextDocument, delay: number): void {
        //Since this is a hack, lets wait for 2 seconds before linting
        //Give user to continue typing before we waste CPU time
        if (this.lastTimeout) {
            clearTimeout(this.lastTimeout);
            this.lastTimeout = null;
        }

        this.lastTimeout = setTimeout(() => {
            this.onLintDocument(document);
        }, delay);
    }

    private onLintDocument(document: vscode.TextDocument): void {
        if (this.pendingLintings.has(document.uri.fsPath)) {
            this.pendingLintings.get(document.uri.fsPath).cancel();
            this.pendingLintings.delete(document.uri.fsPath);
        }

        var cancelToken = new vscode.CancellationTokenSource();
        cancelToken.token.onCancellationRequested(() => {
            if (this.pendingLintings.has(document.uri.fsPath)) {
                this.pendingLintings.delete(document.uri.fsPath);
            }
        });
        this.pendingLintings.set(document.uri.fsPath, cancelToken);

        this.outputChannel.appendLine(`${new Date().toLocaleTimeString()} - File change detected. Starting compilation...`);

        this.linter.runLinter(document.uri.fsPath, document).then(diagnostics => {
            this.diagnosticCollection.clear();
            var messagesIndexedByFile = new Map<string, any[]>();

            //Limit the number of messages to the max value
            //Build the message and suffix the message with the name of the linter used
            diagnostics
                .filter((value, index) => index <= this.settings.linting.maxNumberOfProblems)
                .forEach(d => {
                    if (!messagesIndexedByFile.has(d.fileUri.fsPath)) {
                        messagesIndexedByFile.set(d.fileUri.fsPath, []);
                    }

                    var documentMessages = messagesIndexedByFile.get(d.fileUri.fsPath);
                    var msg = createDiagnostics(d);
                    documentMessages.push(msg);
                });

            //for each document, reset the errors
            messagesIndexedByFile.forEach((messages, filePath) => {
                messages.forEach(msg => {
                    this.outputChannel.appendLine(`${filePath}(${msg.range.start.line + 1},${msg.range.start.character + 1}): ${msg.type} ${msg.code}: ${msg.message}`);
                });
                this.diagnosticCollection.set(vscode.Uri.file(filePath), messages);
            });

            this.outputChannel.appendLine(`${new Date().toLocaleTimeString()} - Compillation complete. Watching for file changes.`);
        });
    }
}