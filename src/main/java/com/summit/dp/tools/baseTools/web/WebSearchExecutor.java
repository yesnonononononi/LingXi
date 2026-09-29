package com.summit.dp.tools.baseTools.web;


import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.tools.baseTools.arguments.WebSearchArguments;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
@Slf4j
@AllArgsConstructor
public class WebSearchExecutor implements ToolExecutor {
    private final WebSearchEngine webSearchEngine;
    private final ObjectMapper objectMapper;


    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {

        try {
            String args = toolExecution.getArgs();
            WebSearchArguments arguments = objectMapper.readValue(args, WebSearchArguments.class);
            if(args == null || args.isBlank())return ToolExecuteResult.err("tool execute failed : args is empty");
            log.info("【ToolCall】 web_search :{}",args);
            String res = this.webSearchEngine.search(arguments);
            return ToolExecuteResult.success( res);
        }catch (Exception e){
            return ToolExecuteResult.err("tool execute failed : "+e.getMessage());
        }
    }

}
