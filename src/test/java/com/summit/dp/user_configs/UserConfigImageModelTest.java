package com.summit.dp.user_configs;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.api.request.UserConfigRequest;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.application.service.DefaultSettingsProvider;
import com.summit.dp.user_configs.application.service.impl.UserConfigServiceImpl;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** 模型选择三态与次数校验必须贯穿设置入口和运行时投影。 */
class UserConfigImageModelTest {
    @Test void selectionLimitsAndExplicitNullArePreserved() {
        UserConfig config=UserConfig.defaultConfig();
        UserConfigRepository repository=mock(UserConfigRepository.class);
        when(repository.findSingleton()).thenReturn(Optional.of(config));
        ModelService models=mock(ModelService.class);
        when(models.findById(9L)).thenReturn(Result.success(ModelConfigVO.builder().provider("default-image-model").credentialConfigured(true).build()));
        DefaultSettingsProvider provider=new DefaultSettingsProvider(repository,"",10);
        UserConfigServiceImpl service=new UserConfigServiceImpl(repository,models,provider,mock(SettingsDirectoryMigrator.class));
        ReflectionTestUtils.setField(service,"activeDataDir","/data");
        assertEquals(3,service.current().getData().getImageGenerationMaxCalls());
        service.update(command(9L,true,2));
        assertEquals(9L,provider.current().orElseThrow().imageModelId());
        assertEquals(2,provider.current().orElseThrow().imageGenerationMaxCalls());
        service.update(command(null,false,0));
        assertEquals(9L,config.getImageModelId());
        assertEquals(0,config.resolveImageGenerationMaxCalls());
        service.update(command(null,true,null));
        assertNull(config.getImageModelId());
        for(int count:new int[]{-1,21}) assertThrows(ClientException.class,()->service.update(command(null,false,count)));
        assertEquals(0,config.resolveImageGenerationMaxCalls());
    }

    @Test void textModelsAndMissingCredentialsAreRejected() {
        UserConfig config=UserConfig.defaultConfig();
        UserConfigRepository repository=mock(UserConfigRepository.class);
        when(repository.findSingleton()).thenReturn(Optional.of(config));
        ModelService models=mock(ModelService.class);
        UserConfigServiceImpl service=new UserConfigServiceImpl(repository,models,new DefaultSettingsProvider(repository,"",10),mock(SettingsDirectoryMigrator.class));
        when(models.findById(9L)).thenReturn(Result.success(ModelConfigVO.builder().provider("default").credentialConfigured(true).build()));
        assertThrows(ClientException.class,()->service.update(command(9L,true,null)));
        when(models.findById(9L)).thenReturn(Result.success(ModelConfigVO.builder().provider("default-image-model").credentialConfigured(false).build()));
        assertThrows(ClientException.class,()->service.update(command(9L,true,null)));
        verify(repository,never()).updateById(any());
    }

    @Test void requestDistinguishesMissingFromExplicitNull() throws Exception {
        ObjectMapper mapper=new ObjectMapper();
        assertFalse(mapper.readValue("{}",UserConfigRequest.class).isImageModelIdPresent());
        UserConfigRequest cleared=mapper.readValue("{\"imageModelId\":null}",UserConfigRequest.class);
        assertTrue(cleared.isImageModelIdPresent());
        assertNull(cleared.getImageModelId());
    }

    private UserConfigCommand command(Long id,boolean present,Integer limit) {
        return new UserConfigCommand(null,null,null,null,null,null,false,null,null,null,null,null,null,null,
                null,false,null,false,id,present,limit);
    }
}
