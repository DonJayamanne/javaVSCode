# Java Debugger
Local variables, arguments, stack trace, step through, partial support for JavaFX, expanding values (Objects, Arrays) etc.

Once installed, do remember to configure the JDK Path (in launch.json, else jdk path is assumed to be in the current path)
Ensure to compile the source code with debug symbols.

E.g. configure the tasks.json file as follows and use run the build task.
(note: if there are no errors displayed in the 'Tasks' output window, then there are no errors)
```json
{
    "version": "0.1.0",
    "command": "javac",
    "isShellCommand": true,
    "showOutput": "always",
    "isWatching": true,
    "suppressTaskName": true,
    "tasks": [
        {
            "taskName": "build",
            "args": ["-g", "${file}"]
        }
    ]
}
```

##[Issues and Feature Requests](https://github.com/DonJayamanne/javaVSCode/issues)
* Enhancements to java debugger (pause and continue, remove break points, multiple threads, JavaFX, watch window, evaluating expressions, etc)

![Image of Debugging](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/debug.gif)

## Requirements
* JDK is installed (version 1.7.0 and later)
 + Path to jdk is configured in launch.json

## Source

[Github](https://github.com/DonJayamanne/javaVSCode)
                
## License

[MIT](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/LICENSE)
