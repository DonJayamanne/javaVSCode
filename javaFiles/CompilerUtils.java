import java.util.*;
import java.io.*;
import java.net.*;

import java.nio.file.Files;
import java.nio.file.Paths;

import java.lang.reflect.InvocationTargetException;
import java.lang.StringBuilder;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;
import javax.tools.JavaCompiler.CompilationTask;
import javax.tools.JavaFileObject.Kind;
import javax.tools.StandardJavaFileManager;

public class CompilerUtils {
    private static String separator = "0EC18C4E-E0E1-4C42-B325-366003E0D504";
    public final static String END_MARKER = "5EC18C4E-E0E1-4C42-B325-366003E0D505";
     
    public static void main(String args[]) {
        int portNumber = 10007;
        String fileToCompile = "";
        try {
            if (args.length > 0){
                portNumber = Integer.parseInt(args[0]);
                separator = args[1];
            }
        }
        catch (NumberFormatException ex){
            fileToCompile = args[0];
        }
        
        if (fileToCompile.length() > 0){
            CompileFromCommandLine(args);
        }
        else {
            CompileFromSockets(portNumber);
        }
    }
    
    private static void CompileFromCommandLine(String[] args){
        String[] files = {args[0]};
        ArrayList<String> options = new ArrayList<String>();
        options.add("-g");        
        // options.addAll(Arrays.asList("-classpath",System.getProperty("java.class.path")));        
        options.addAll(Arrays.asList("-classpath", "C:/Program Files/Java/jre1.8.0_91/lib/ext/jfxrt.jar;."));                
        System.out.println(compileCode(files, options));
    }
        
    private static void CompileFromSockets(int portNumber){
        ServerSocket serverSocket = null; 

        try { 
            serverSocket = new ServerSocket(portNumber);
            System.out.println(String.format("Listening on port %d", portNumber)); 
        } 
        catch (IOException e) {
            System.err.println(String.format("Could not listen on port: %d. Exception is " + e)); 
            System.exit(1); 
        } 

        while(true) {
            Socket clientSocket = null; 
            System.out.println ("Waiting for connection.....");

            try { 
                clientSocket = serverSocket.accept(); 
                ClientThread cT = new ClientThread(clientSocket);
                    
                new Thread(cT).start();            

                System.out.println ("Connection successful");
                System.out.println ("Waiting for input.....");
            } 
            catch (IOException e) { 
                System.err.println("Accept failed."); 
                System.exit(1); 
            } 
        }
    }
    
    public static String compileCode(String[] fileNames, List<String> options){
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<JavaFileObject>();

        StandardJavaFileManager fileManager = compiler.getStandardFileManager(diagnostics, null, null);
        Iterable<? extends JavaFileObject> compilationUnits = fileManager.getJavaFileObjectsFromStrings(Arrays.asList(fileNames));
        
        CompilationTask task = compiler.getTask(null, null, diagnostics, options, null, compilationUnits);
        boolean success = task.call();
        StringBuilder textToSend = new StringBuilder();
        for (Diagnostic diagnostic : diagnostics.getDiagnostics()) {
            textToSend.append("CODE:" + diagnostic.getCode());
            textToSend.append(separator);
            textToSend.append("KIND:" + getDiagnosticKind(diagnostic.getKind()));
            textToSend.append(separator);
            textToSend.append("POSITION:" + diagnostic.getPosition());            
            textToSend.append(separator);
            textToSend.append("LINE:" + diagnostic.getLineNumber());            
            textToSend.append(separator);
            textToSend.append("START:" + diagnostic.getStartPosition());
            textToSend.append(separator);
            textToSend.append("END:" + diagnostic.getEndPosition());
            textToSend.append(separator);
            // textToSend.append(getFileObjectKind(diagnostic.getSource().getKind()));
            // textToSend.append(separator);
            // textToSend.append(diagnostic.getSource().toUri().toString());
            // textToSend.append(separator);
            textToSend.append("SOURCE:" + diagnostic.getSource());
            textToSend.append(separator);
            textToSend.append("MESSAGE:" + diagnostic.getMessage(null));
            textToSend.append(separator);
        }      
        
        System.out.println(textToSend.toString().replaceAll(separator, "\r\n"));
        textToSend.append(END_MARKER);
        
        return "ERRORS:" + textToSend.length() + ":" + textToSend.toString();
    }
    private static String getFileObjectKind(JavaFileObject.Kind kind){
        String kindValue = "";
        switch (kind){
            case CLASS: kindValue = "CLASS";
                break;
            case HTML: kindValue = "HTML";
                break;
            case OTHER: kindValue = "OTHER";
                break;
            case SOURCE: kindValue = "SOURCE";
                break;
        }
        return kindValue;
    }
    private static String getDiagnosticKind(Diagnostic.Kind kind){
        String kindValue = "";
        switch (kind){
            case ERROR: kindValue = "ERROR";
                break;
            case MANDATORY_WARNING: kindValue = "MANDATORY_WARNING";
                break;
            case NOTE: kindValue = "NOTE";
                break;
            case OTHER: kindValue = "OTHER";
                break;
            case WARNING: kindValue = "WARNING";
                break;
        }
        return kindValue;
    }
}

class ClientThread implements Runnable
{
    Socket clientSocket;        
    public ClientThread(Socket socket)
    {
        clientSocket = socket;
    }
        
    public void run()
    {
        try {        
            PrintWriter out = new PrintWriter(clientSocket.getOutputStream(), true); 
            BufferedReader in = new BufferedReader(new InputStreamReader( clientSocket.getInputStream())); 

            String inputLine; 
            ArrayList<String> filesToCompile = new ArrayList<String>();
            ArrayList<String> options = new ArrayList<String>();
            boolean readingOptions = false;
            while ((inputLine = in.readLine()) != null) { 
                if (inputLine.equals("Bye.")) {
                    break; 
                }
                if (inputLine.equals("START")){
                    filesToCompile.clear();
                    continue;
                }
                if (inputLine.equals("STARTOPTIONS")){
                    readingOptions = true;
                    options.clear();
                    continue;
                }
                if (inputLine.equals("ENDOPTIONS")){
                    readingOptions = false;
                    continue;
                }
                if (inputLine.equals("END")){
                    try {
                        String compilerOutput = CompilerUtils.compileCode(filesToCompile.toArray(new String[0]), options);                 
                        out.println(compilerOutput); 
                    }
                    catch (Exception ex){
                        String messageToSend = "EXCEPTION:" + (ex.getMessage().length() + CompilerUtils.END_MARKER.length()) + ":" + ex.getMessage() + CompilerUtils.END_MARKER;
                        out.println(messageToSend);
                    }
                    
                    System.out.println("File To Compile: " + inputLine);
                }
                if (readingOptions){
                    options.add(inputLine);
                }
                else {
                    filesToCompile.add(inputLine);
                }
            } 

            out.close(); 
            in.close(); 
            clientSocket.close(); 
        }
        catch (Exception ex){
            System.out.println("Exception:" + ex);
        }
    }
}