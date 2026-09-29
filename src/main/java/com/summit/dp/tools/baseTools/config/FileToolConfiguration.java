package com.summit.dp.tools.baseTools.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.tools.baseTools.file.record.Differ;
import com.summit.dp.tools.baseTools.file.record.FileHasher;
import com.summit.dp.tools.baseTools.file.record.FileRecordManager;
import com.summit.dp.tools.baseTools.file.record.FileRecordStore;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.tool.*;
import com.summit.dp.tools.baseTools.file.record.DefaultFileHasher;
import com.summit.dp.tools.baseTools.file.record.DefaultFileRecordManager;
import com.summit.dp.tools.baseTools.file.record.DefaultFileRecordStore;
import com.summit.dp.tools.baseTools.file.record.FileRecordRestorer;
import com.summit.dp.tools.baseTools.file.edit.EditDiffer;
import com.summit.dp.tools.baseTools.file.edit.EditFileToolExecutor;
import com.summit.dp.tools.baseTools.file.read.ReadFileToolExecutor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * 文件读写工具的装配。
 *
 * <p>工具不再有 yaml {@code enabled} 开关：一个工具要么在本应用里存在，要么不存在 —— 装配由代码
 * 决定，而不是由某个部署恰好写没写一个键决定。这样「这个工具为什么没生效」不会再变成一个查配置
 * 文件的问题。要停用某个工具，从 Agent 的工具清单里去掉它即可（框架侧名单即授权）。</p>
 */
@org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
public class FileToolConfiguration {
    @Bean
    @ConditionalOnMissingBean(name = "editFileToolDefinition")
    public ToolDefinition<EditFileToolExecutor> editFileToolDefinition(ObjectMapper objectMapper, RuntimeEventPublisher runtimeEventPublisher, FileRecordManager fileRecordManager) {
        String name = "edit_file";
        return ToolDefinition.<EditFileToolExecutor>builder()
                .executor(new EditFileToolExecutor(objectMapper, differ(), fileRecordManager, runtimeEventPublisher))
                .id(name)
                .name(name)
                .concurrentPolicy(ConcurrentPolicy.SERIAL_MUTATION)
                .description("Edit file content using REPLACE, INSERT_BEFORE, INSERT_AFTER or DELETE, and return the applied diff.")
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "type": {"type": "string", "enum": ["INSERT_BEFORE", "INSERT_AFTER", "REPLACE", "DELETE"], "description": "INSERT_* : insert content behind or in front of anchor. "},
                            "anchor": {"type": "string", "description": "The anchor of Insert operation it is a required parameter if type in terms of INSERT unless want to insert a empty file"},
                            "path": {"type": "string", "description": "File path relative to the workspace root. Do not use absolute paths it is a required parameter"},
                            "oldText": {"type": "string", "description": "Old text to be replaced it is a optional parameter"},
                            "newText": {"type": "string", "description": "New text to replace old text.it is empty when type is DELETE .it is a optional parameter"}
                          }
                        }
                        """)
                .maxOutput(200)
                .timeout(30L)
                .build();
    }

    @Bean
    @ConditionalOnMissingBean(name = "readFileToolDefinition")
    public ToolDefinition<ReadFileToolExecutor> readFileToolDefinition(ObjectMapper objectMapper) {
        String name = "read_file";
        return ToolDefinition.<ReadFileToolExecutor>builder()
                .executor(new ReadFileToolExecutor(objectMapper))
                .id(name)
                .name(name)
                .description("Read file content, optionally limited to a startLine/endLine range.")
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "path": {"type": "string", "description": "File path it is a required parameter"},
                            "startLine": {"type": "integer", "description": "Start line to read If both startLine and endLine are empty, read the entire file. start at zero"},
                            "endLine": {"type": "integer", "description": "End line to read If both startLine and endLine are empty, read the entire file"}
                          }
                        }
                        """)
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .maxOutput(3_000)
                .timeout(30L)
                .build();
    }


    @Bean
    @ConditionalOnMissingBean
    public Differ differ(){
        return new EditDiffer();
    }


    @Bean
    @ConditionalOnMissingBean
    public FileRecordStore fileRecordStore(){
        return new DefaultFileRecordStore();
    }

    @Bean
    @ConditionalOnMissingBean
    public FileHasher fileHasher() {
        return new DefaultFileHasher();
    }

    @Bean
    @ConditionalOnMissingBean
    public FileRecordManager fileRecordManager(FileRecordStore fileRecordStore, FileHasher fileHasher) {
        return new DefaultFileRecordManager(fileRecordStore, new FileRecordRestorer(fileHasher), fileHasher);
    }

}
