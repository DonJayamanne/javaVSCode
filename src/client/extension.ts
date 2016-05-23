'use strict';

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {LintProvider} from './providers/lintProvider';
import * as settings from './common/configSettings'
const JAVA: vscode.DocumentFilter = { language: 'java', scheme: 'file' }
let outChannel: vscode.OutputChannel;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    var rootDir = context.asAbsolutePath(".");
    var javaSettings = new settings.JavaSettings();
    
    outChannel = vscode.window.createOutputChannel('Java');
    outChannel.clear();

    context.subscriptions.push(new LintProvider(context, javaSettings, outChannel));
}

// this method is called when your extension is deactivated
export function deactivate() {
}