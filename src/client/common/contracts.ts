import {DebugProtocol} from 'vscode-debugprotocol';
import {StackFrame} from 'vscode-debugadapter';

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    cwd: string;
    startupClass: string;
    jdkPath?: string;
    stopOnEntry?: boolean;
    externalConsole?: boolean;
    debugOptions?: string[];
    sourcePath?: string[];
    classpath?: string[];
    options?: string[];
    args?: string[];
}

export interface AttachRequestArguments extends LaunchRequestArguments {
    remoteHost?: string;
    remotePort: number;
}

export function isAttachRequestArguments(arg: LaunchRequestArguments | AttachRequestArguments): arg is AttachRequestArguments {
    return (arg as AttachRequestArguments).remotePort !== undefined;
}

export interface IJavaThread {
    //IsWorkerThread: boolean;
    Name: string;
    Id: number;
    HexId: string;
    //Frames: IJavaStackFrame[];
    Frames: StackFrame[];
}

export interface IJavaStackFrame {
    StartLine: number;
    EndLine: number;
    Thread: IJavaThread;
    LineNo: number;
    FunctionName: string;
    FileName: string;
    FrameId: number;
    Locals: IJavaEvaluationResult[];
    Parameters: IJavaEvaluationResult[];
}
export enum JavaEvaluationResultFlags {
    None = 0,
    Expandable = 1,
    MethodCall = 2,
    SideEffects = 4,
    Raw = 8,
    HasRawRepr = 16,
}

export interface IJavaEvaluationResult {
    Flags: JavaEvaluationResultFlags;
    IsExpandable: boolean;
    StringRepr: string;
    TypeName: string;
    Length: number;
    ExceptionText?: string;
    Expression: string;
    ChildName: string;
    Frame: IJavaStackFrame;
    DumpRepr: string;
    DumpLines: string[]
}

export interface IDebugVariable {
    variables: IJavaEvaluationResult[];
    evaluateChildren?: Boolean;
}

export interface ICommand {
    name: string;
    prompt?: string
    promptResponse?: string;
    commandLineDetected?: boolean;
    commandLine: string;
    responseProtocol?: DebugProtocol.Response
}

export interface IStackInfo {
    fileName: string,
    lineNumber: number,
    function: string
    source: string
}
