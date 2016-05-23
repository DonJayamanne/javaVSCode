# Java
Linting and Debugging (Local variables, arguments, step through, etc).

Once installed, do remember to configure the JDK Path (both in settings and launch.json, else jdk path is assumed to be in the current path)

##Features
* Linting (uses the Java Compiler to identify issues. Errors are identifed upon saving changes)
* Debugging with support for local variables, arguments, stack information, break points

##[Issues and Feature Requests](https://github.com/DonJayamanne/javaVSCode/issues)
* Enhancements to java debugger (pause and continue, remove break points, etc)
* Support for configuration of compiler settings
* Snippets

## Feature Details
* Linting
 + Java Compiler API is used to identify issues upon saving changes
 + (ensure the settings file is configured to point to the jdk path)
* Debuggging
 + Step through code (Step in, Step out, Continue)
 + Add break points
 + (missing debugging features coming soon, such as watch window, etc)
 + (ensure the launch.json file is configured to point to the jdk path)

![Image of Linting](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/linter.gif)

![Image of Debugging](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/images/debug.gif)

## Requirements
* JDK is installed (version 1.7.0 and later)
 + Path to jdk is configured in settings (for linting)
 + Path to jdk is configured in launch.json (for debugging)

## Source

[Github](https://github.com/DonJayamanne/javaVSCode)
                
## License

[MIT](https://raw.githubusercontent.com/DonJayamanne/javaVSCode/master/LICENSE)
