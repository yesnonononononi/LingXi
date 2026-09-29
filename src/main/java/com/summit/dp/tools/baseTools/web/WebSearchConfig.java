package com.summit.dp.tools.baseTools.web;

import lombok.Builder;


@Builder
public record WebSearchConfig (String baseUrl, String apiKey,Long timeout,Integer maxResult){

}
