package com.summit.dp.workflow.infrastructure.tools.config;

import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.record.*;
import com.summit.dp.workflow.infrastructure.tools.file.record.persistence.FileRecordMapper;
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
    public FileRecordStore fileRecordStore(FileRecordMapper mapper, BaselineFileStore baselines) {
        // 记录必须跨进程存活：历史会话的改动清单不能因为后端重启就消失。
        return new H2FileRecordStore(mapper, baselines);
    }

    @Bean
    @ConditionalOnMissingBean
    public FileRecordManager fileRecordManager(FileRecordStore fileRecordStore) {
        return new DefaultFileRecordManager(fileRecordStore);
    }

}
