import java.util.*;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;

import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.net.URI;
import java.util.Arrays;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;
import javax.tools.JavaCompiler.CompilationTask;
import javax.tools.JavaFileObject.Kind;
import javax.tools.StandardJavaFileManager;
import javaFiles.*;

public class sample {
    private static Scanner input;
  
    public static void main(String args[]) {
        input = new Scanner(System.in);
        sample2.test();      
        startListeningForFiles();
    }
  
    private static void startListeningForFiles(){
        String fileToProcess;
        String fileContents;
        while (true){
            fileToProcess = getNextFileForProcessing();
            try {
                fileContents = getFileContents(fileToProcess);
                CompileCode(fileToProcess, fileContents);
            }
            catch (Exception ex){
                System.out.println("-ERROR-");
                continue;
            }
            
            System.out.println(fileToProcess);
            System.out.println("Completed");
        }
    }
    
    private static void CompileCode(String fileName, String code){
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<JavaFileObject>();

         JavaFileObject file = new JavaSourceFromString("sample", code);

        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<JavaFileObject>();
        StandardJavaFileManager fileManager = compiler.getStandardFileManager(diagnostics, null, null);
        Iterable<? extends JavaFileObject> compilationUnits = fileManager.getJavaFileObjectsFromStrings(Arrays.asList(fileName));
        
        Iterable<? extends JavaFileObject> compilationUnits = Arrays.asList(file);
        CompilationTask task = compiler.getTask(null, null, diagnostics, null, null, compilationUnits);
        boolean success = task.call();
        
        for (Diagnostic diagnostic : diagnostics.getDiagnostics()) {
            System.out.println("Code: " + diagnostic.getCode());
            System.out.println("Kind: " + diagnostic.getKind());
            System.out.println("Position: " + diagnostic.getPosition());            
            System.out.println("Line: " + diagnostic.getLineNumber());            
            System.out.println("Start: " + diagnostic.getStartPosition());
            System.out.println("End: " + diagnostic.getEndPosition());
            System.out.println("Source: " + diagnostic.getSource());
            System.out.println("Message: " + diagnostic.getMessage(null));
        }      
        
    }
    private static String getFileContents(String filePath) throws IOException {
        return new String(Files.readAllBytes(Paths.get(filePath)));
    }
    
    private static String getNextFileForProcessing(){
        return input.nextLine();
    }
    
}