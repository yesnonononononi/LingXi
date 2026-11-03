package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.ModelConfig;
import com.summit.core.model.image.ImageGenerationOptions;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
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
        assertThrows(ClientException.class, () -> validator.resolve(omitted, config));
    }

    @ParameterizedTest
    @CsvSource({"gpt-image-1, 1024x1536", "gpt-image-1-mini, 1536x1024", "gpt-image-1.5, auto",
            "vendor/gpt-image-1.5-2025-12-16, 1024x1024", "dall-e-2, 256x256", "dall-e-2, 512x512", "dall-e-3, 1792x1024"})
    void acceptsOnlyTheSelectedModelsPresets(String model, String size) throws Exception {
        assertEquals(size, resolve(model, size).size());
    }

    @ParameterizedTest
    @CsvSource({"gpt-image-1, 1792x1024", "gpt-image-1-mini, 1536x864", "dall-e-2, 1536x1024",
            "dall-e-3, 512x512", "dall-e-3, auto", "image-test, 2048x2048"})
    void rejectsSizesFromAnotherModelFamily(String model, String size) {
        ClientException error = assertThrows(ClientException.class, () -> resolve(model, size));
        assertTrue(error.getMessage().contains("可不传"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"auto", "1536x864", "1024x640", "3840x2160", "2160x3840", "1536x512"})
    void acceptsFlexibleSizesIncludingBoundaryValues(String size) throws Exception {
        for (String model : new String[]{"gpt-image-2", "vendor/gpt-image-2-2026-04-21",
                "gpt-image-2.5-sunburst", "gpt-image-2.5-flare-2026-09-08"}) {
            assertEquals(size, resolve(model, size).size());
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"1000x1024", "1024x1000", "3856x2048", "4096x1024", "512x512", "512x2048", "3008x3008",
            "1008x640", "3840x2176", "1552x512", "1024X1024", "1024x0", "2147483647x1024", "", " 1024x1024"})
    void rejectsMalformedAndOutOfBoundsFlexibleSizes(String size) {
        assertThrows(ClientException.class, () -> resolve("gpt-image-2", size));
    }

    @ParameterizedTest
    @ValueSource(strings = {"{\"size\":1024}", "{\"size\":[]}", "{\"quality\":true}", "{\"quality\":\"\"}",
            "{\"count\":0}", "{\"count\":2}", "{\"count\":\"1\"}", "{\"count\":1.0}", "{\"count\":4294967297}"})
    void refusesWrongTypesAndMultipleImages(String json) {
        assertThrows(ClientException.class, () -> validator.resolve(mapper.readTree(json), ModelConfig.builder().modelName("gpt-image-1").build()));
    }

    @Test void qualityMustAlsoMatchTheSelectedModel() throws Exception {
        JsonNode high = mapper.readTree("{\"quality\":\"xhigh\"}");
        assertEquals("xhigh", validator.resolve(high, ModelConfig.builder().modelName("gpt-image-2.5-flare").build()).quality());
        assertThrows(ClientException.class, () -> validator.resolve(high, ModelConfig.builder().modelName("gpt-image-2").build()));
        assertThrows(ClientException.class, () -> validator.resolve(mapper.readTree("{\"quality\":\"high\"}"),
                ModelConfig.builder().modelName("dall-e-3").build()));
    }

    private ImageGenerationOptions resolve(String model, String size) throws Exception {
        return validator.resolve(mapper.createObjectNode().put("size", size), ModelConfig.builder().modelName(model).build());
    }
}
