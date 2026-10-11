package com.summit.dp.workflow.infrastructure.tools.web;

import lombok.Builder;

@Builder
public record WebSearchConfig (String baseUrl, String apiKey,Long timeout,Integer maxResult){

}
