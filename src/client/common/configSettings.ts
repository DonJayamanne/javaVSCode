'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface IJavaSettings {
    jdkPath: string;
    devOptions: any[];
    linting: ILintingSettings;
    compiler: ICompilerSettings;
}
export interface ILintingSettings {
    enabled: boolean;
    maxNumberOfProblems: number;
}
export interface ICompilerSettings {
    files: string[];
    options?: string[];
}
export class JavaSettings implements IJavaSettings {
    constructor() {
        vscode.workspace.onDidChangeConfiguration(() => {
            this.initializeSettings();
        });

        this.initializeSettings();
    }
    private initializeSettings() {
        var javaSettings = vscode.workspace.getConfiguration("java");
        this.jdkPath = javaSettings.get<string>("jdkPath");
        this.devOptions = javaSettings.get<any[]>("devOptions");
        this.compiler = javaSettings.get<ICompilerSettings>("compiler");
        this.devOptions = Array.isArray(this.devOptions) ? this.devOptions : [];
        var lintingSettings = javaSettings.get<ILintingSettings>("linting");
        if (this.linting) {
            Object.assign<ILintingSettings, ILintingSettings>(this.linting, lintingSettings);
        }
        else {
            this.linting = lintingSettings;
        }
    }

    public jdkPath: string;
    public devOptions: any[];
    public linting: ILintingSettings;
    public compiler: ICompilerSettings;
}