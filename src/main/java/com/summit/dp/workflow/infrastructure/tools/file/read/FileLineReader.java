package com.summit.dp.workflow.infrastructure.tools.file.read;

import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.LineNumberReader;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Objects;

public class FileLineReader {
    /** 行号从零开始，边界均未指定时保持全文读取。 */
    public static String read(File file, Integer startLine, Integer endLine) throws IOException {

        if(startLine ==null && endLine == null){
            return Files.readString(file.toPath());
        }

        startLine = Objects.requireNonNullElse(startLine,0);

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
