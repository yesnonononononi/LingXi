package com.summit.dp.tools.baseTools.arguments;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WebSearchArguments {
    private String query;
    @JsonProperty("max_results")
    @JsonAlias("maxResults")
    private String maxResults;
    @JsonProperty("start_date")
    @JsonAlias("startDate")
    private String startDate;
    @JsonProperty("end_date")
    @JsonAlias("endDate")
    private String endDate;
}
