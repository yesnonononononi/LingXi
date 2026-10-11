package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.Data;

import java.util.List;

@Data
public class ChoiceQuestionArgument {
    private String question;
    private List<String> options;
}
