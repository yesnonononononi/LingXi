package com.summit.dp.tools.baseTools.file.read;

import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.LineNumberReader;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Objects;
/**
 * File line reader
 * @author summit
 */
public class FileLineReader {
    /**
     * Read a file and return the content by line range
     * if both startLine and endLine are null, read the entire file
     * @param file target file
     * @param startLine start line (start from zero)
     * @param endLine end line
     * @return file content by line range
     */
    public static String read(File file, Integer startLine, Integer endLine) throws IOException {
        // If both startLine and endLine are null, read the entire file
        if(startLine ==null && endLine == null){
            return Files.readString(file.toPath());
        }
        // If startLine is null, set it to 0
        startLine = Objects.requireNonNullElse(startLine,0);
        // If endLine is null, set it to the last line of the file
        endLine = Objects.requireNonNullElse(endLine, Integer.MAX_VALUE);
        ArrayList<String> result = new ArrayList<>();
        String line;
        int currentLine = 0;
        try (LineNumberReader lineNumberReader = new LineNumberReader(new FileReader(file))) {
            while ((line = lineNumberReader.readLine()) != null) {
                if (currentLine >= startLine && currentLine <= endLine) {
                    result.add(line);
                }
                currentLine++;
                if (currentLine > endLine) break;
            }
        }
        return String.join("\n", result);
    }
}
