# Java Debugger

![java-debugger](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/icon.png)

Local variables, arguments, stack trace, step through, partial support for JavaFX, expanding values (Objects, Arrays) etc.

## Requirements

> NOTE: Path to JDK is configured in launch.json

* JDK is installed (version 1.7.0 and later)

Once installed, do remember to configure the JDK Path (in launch.json, else jdk path is assumed to be in the current path)
Ensure to compile the source code with debug symbols.

Configure the `tasks.json` file as follows and use run the build task.

> Note: `-g` is needed to compile your code with debugging support, allowing to see variables value

![variables](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/variables.png)

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "taskName": "Compile Java",
            "type": "shell",
            "command": "javac -g ${file}",
            "group": {
                "kind": "build",
                "isDefault": true
            }
        }
    ]
}
```

Example launch configuration (`launch.json`):

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
    "classpath": ["${workspaceRoot}/bin"],    // Indicates the location of your .class files
    "options": []                             // Additional options to pass to the java executable
    "args": []                                // Command line arguments to pass to the startup class
}
```

## Features

Easy debugger settings.

![Image of Debugging](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/debug.gif)

Debug GUI applications.

![Image of JavaFx](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/javafx.gif)

Inspect variables, set breakpoints and see output in console.

![Image of Loop](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/Loop.gif)

## Roadmap

* Enhancements to java debugger (pause and continue, etc)
* Debugging of Multie Threaded apps is possible but very flaky. The debugger could at times hang.
* Exceptions support [#46](https://github.com/DonJayamanne/javaVSCode/issues/46)

## Known issues

* Can't use integrated terminal yet. [#71](https://github.com/DonJayamanne/javaVSCode/issues/71)
* Sometimes debugger shows nothing, try to restart it. [#27](https://github.com/DonJayamanne/javaVSCode/issues/27)
* Debugging Spring Boot Applications, [#13](https://github.com/DonJayamanne/javaVSCode/issues/13)

## Release Notes

See [ChangeLog](https://github.com/DonJayamanne/javaVSCode/blob/master/CHANGELOG.md)

## Contributing

1. Fork it https://github.com/DonJayamanne/javaVSCode/fork
2. Create your feature branch `git checkout -b my-new-feature`
3. Commit your changes `git commit -am 'Add some feature'`
4. Push to the branch `git push origin my-new-feature`
5. Create a new Pull Request

## Contributors

- [DonJayamanne](https://github.com/DonJayamanne/) Don Jayamanne - creator, maintainer
- [faustinoaq](https://github.com/faustinoaq) Faustino Aguilar - contribuitor
- [Sel-en-ium](https://github.com/Sel-en-ium) Sel-en-ium - contribuitor
- [lacivert](https://github.com/lacivert) Yasin Okumus - contribuitor
- [dlee-nvisia](https://github.com/dlee-nvisia) Dave - contribuitor
- [TSedlar](https://github.com/TSedlar) Tyler Sedlar - contribuitor
- [rianadon](https://github.com/rianadon) rianadon - contribuitor
- [llgcode](https://github.com/llgcode) llgcode - contribuitor
- [khe817](khe817) Ngan Bui - contribuitor

## Source

[Github](https://github.com/DonJayamanne/javaVSCode)

## License

[MIT](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/LICENSE)
