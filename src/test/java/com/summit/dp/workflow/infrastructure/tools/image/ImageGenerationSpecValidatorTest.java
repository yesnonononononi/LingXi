package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.ModelConfig;
import com.summit.core.model.image.ImageGenerationOptions;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.*;

class ImageGenerationSpecValidatorTest {
    private final ImageGenerationSpecValidator validator = new ImageGenerationSpecValidator();
    private final ObjectMapper mapper = new ObjectMapper();

    @Test void omittedSpecificationsUseModelDefaultsAndOtherwiseSquareSize() throws Exception {
        ModelConfig config = ModelConfig.builder().modelName("gpt-image-1").build();
        JsonNode omitted = mapper.readTree("{}");
        assertEquals(new ImageGenerationOptions("1024x1024", null, 1), validator.resolve(omitted, config));
        ModelConfig.ImageOptions defaults = ModelConfig.ImageOptions.builder().size("1024x1536").quality("low").count(2).build();
        config.setImageOptions(defaults);
        assertEquals(new ImageGenerationOptions("1024x1536", "low", 1), validator.resolve(omitted, config));
        assertEquals(new ImageGenerationOptions("1536x1024", "low", 1),
                validator.resolve(mapper.readTree("{\"size\":\"1536x1024\"}"), config));
        assertSame(defaults, config.getImageOptions());
        config.setImageOptions(defaults.toBuilder().size("999x999").build());
        assertEquals("999x999", validator.resolve(omitted, config).size());
    }

    @ParameterizedTest
    @ValueSource(strings = {"auto", "1x1", "123x456", "1000x1024", "4096x1024", "3008x3008", "999999999999999999999x2"})
    void acceptsFormattedSizesWithoutApplyingModelLimits(String size) throws Exception {
        for (String model : new String[]{"gpt-image-1", "gpt-image-2", "dall-e-2", "dall-e-3", "custom-image-model"}) {
            assertEquals(size, resolve(model, size).size());
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"1024X1024", "1024x0", "0x1024", "-1x1024", "1024*1024", "1024.5x1024", "1024x", "", " 1024x1024"})
    void rejectsOnlyMalformedSizes(String size) {
        assertThrows(ClientException.class, () -> resolve("gpt-image-2", size));
    }

    @ParameterizedTest
    @ValueSource(strings = {"{\"size\":1024}", "{\"size\":[]}", "{\"quality\":true}", "{\"quality\":\"\"}",
            "{\"count\":0}", "{\"count\":2}", "{\"count\":\"1\"}", "{\"count\":1.0}", "{\"count\":4294967297}"})
    void refusesWrongTypesAndMultipleImages(String json) {
        assertThrows(ClientException.class, () -> validator.resolve(mapper.readTree(json), ModelConfig.builder().modelName("gpt-image-1").build()));
    }

    @Test void forwardsAnyNonBlankQualityWithoutAModelWhitelist() throws Exception {
        for (String quality : new String[]{"xhigh", "high", "custom-quality"}) {
            JsonNode args = mapper.createObjectNode().put("quality", quality);
            assertEquals(quality, validator.resolve(args, ModelConfig.builder().modelName("dall-e-3").build()).quality());
        }
    }

    private ImageGenerationOptions resolve(String model, String size) throws Exception {
        return validator.resolve(mapper.createObjectNode().put("size", size), ModelConfig.builder().modelName(model).build());
    }
}
