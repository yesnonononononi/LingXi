package com.summit.dp.workflow.infrastructure.tools.config;

import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileHasher;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.Differ;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileHasher;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordRestorer;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.image.ImageNormalizer;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 共享文件记录与图像依赖，避免执行器分别创建。 */
@Configuration(proxyBeanMethods = false)
public class FileToolConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public ImageNormalizer imageNormalizer() {
        return new ImageNormalizer();
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
