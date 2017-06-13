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
Example launch configuration (launch.json):
```javascript
{
    "name": "Java",
    "type": "java",
    "request": "launch",
    "stopOnEntry": true,      
    "preLaunchTask": "build",                 // Runs the task created above before running this configuration
    "jdkPath": "${env:JAVA_HOME}/bin",        // You need to set JAVA_HOME enviroment variable
    "cwd": "${workspaceRoot}",
    "startupClass": "my.package.MyMainClass", // The class you want to run
    "sourcePath": ["${workspaceRoot}/src"],   // Indicates where your source (.java) files are
    "options": [
      "-classpath", "${workspaceRoot}/bin"    // Idicates the location of your .class files
    ]
}
```



## [Issues and Feature Requests](https://github.com/DonJayamanne/javaVSCode/issues)
* Enhancements to java debugger (pause and continue, etc)
* Debugging of Multie Threaded apps is possible but very flaky. The debugger could at times hang.

![Image of Debugging](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/debug.gif)
![Image of JavaFx](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/javafx.gif)
![Image of Loop](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/Loop.gif)

## Requirements
* JDK is installed (version 1.7.0 and later)
 + Path to jdk is configured in launch.json

## Release Notes

See [Change 
Log](https://github.com/DonJayamanne/javaVSCode/blob/master/CHANGELOG.md)

## Big thanks to [Faustino Aguilar](https://github.com/faustinoaq)

## Source

[Github](https://github.com/DonJayamanne/javaVSCode)
                
## License

[MIT](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/LICENSE)
