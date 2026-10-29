package com.summit.dp.workflow.infrastructure.memory;

import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

@Component
@RequiredArgsConstructor
public class MemoryMonitor implements LoopInterceptor {
    @Value("${lingxi.memory.location}") String memoryLocation;
    @Value("${lingxi.memory.maxChars}") Long maxMemoryChars;
    @Override
    public int order() {
        return Integer.MIN_VALUE + 1; //位于最顶层
    }

    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        if(maxMemoryChars <= 0 || memoryLocation == null || memoryLocation.isEmpty()) return InterceptorResult.NONE;
        if(isExceed()){
            context.appendMessage(List.of(SystemMessageEntity.builder().text(
                    "NOTICE: the memory has exceeded the max range: "+ maxMemoryChars + ", you must compact it"
            ).build()));
        }
        return LoopInterceptor.super.onBeforeModelInvoke(context);
    }

    private boolean isExceed() {
        Path path = Path.of(memoryLocation);
        if (Files.isRegularFile(path)) {
            try {
                return Files.readString(path).length() >= maxMemoryChars;
            } catch (IOException ignore) {
            }
        }
        return false;
    }


}
