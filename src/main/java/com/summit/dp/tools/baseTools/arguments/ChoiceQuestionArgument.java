package com.summit.dp.tools.baseTools.arguments;

import lombok.Data;

import java.util.List;

@Data
public class ChoiceQuestionArgument {
    private String question;
    private List<String> options;
}
