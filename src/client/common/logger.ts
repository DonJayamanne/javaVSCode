import * as vscode from 'vscode';
import * as settings from './configSettings'

let outChannel: vscode.OutputChannel;
let javaSettings: settings.IJavaSettings;

class Logger {
    static initializeChannel() {
        if (javaSettings) return;
        javaSettings = new settings.JavaSettings();
        if (javaSettings.devOptions && javaSettings.devOptions.indexOf("DEBUG") >= 0) {
            outChannel = vscode.window.createOutputChannel('Java');
        }
    }

    static write(category: string = "log", title: string = "", message: any) {
        Logger.initializeChannel();
        if (title.length > 0) {
            Logger.writeLine(category, "---------------------------");
            Logger.writeLine(category, title);
        }
        
        Logger.writeLine(category, message);
        
        if (message instanceof Error){
            var ex = <Error>message;
            Logger.writeLine(category, `Stack - ${ex.stack}`);
        }
    }
    static writeLine(category: string = "log", line: any) {
        console[category](line);
        if (outChannel) {
            outChannel.appendLine(line);
        }
    }
}
export function error(title: string = "", message: any) {
    Logger.write.apply(Logger, ["error", title, message]);
}
export function warn(title: string = "", message: any) {
    Logger.write.apply(Logger, ["warn", title, message]);
}
export function log(title: string = "", message: any) {
    Logger.write.apply(Logger, ["log", title, message]);
}
