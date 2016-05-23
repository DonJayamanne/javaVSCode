# Java
Linting and Debugging (Local variables, arguments, step through, etc).

Once installed, do remember to configure the JDK Path

##Features
* Linting (uses the Java Compiler to identify issues. Errors are identifed upon saving changes)
* Debugging with support for local variables, arguments, stack information, break points

##[Issues and Feature Requests](https://github.com/DonJayamanne/javaVSCode/issues)
* Enhancements to java debugger
* Snippets

## Feature Details
* Linting
 + Java Compiler API is used to identify issues upon saving changes
 + (ensure the settings file is configured to point to the jdk path)
* Debuggging
 + Step through code (Step in, Step out, Continue)
 + Add break points
 + (missing debugging features coming soon, such as watch window, etc)


![Image of Linting](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/general.gif)

![Image of Linting Watching](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/goToDef.gif)

![Image of Debugging](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/standardDebugging.gif)

![Image of Debugging JavaFX](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/flaskDebugging.gif)

## Requirements
* JDK is installed
 + Path to jdk is configured in settings (for linting)
 + Path to jdk is configured in launch.json (for debugging)

## Source

[Github](https://github.com/DonJayamanne/javaVSCode)

                
## License

[MIT](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/LICENSE)
