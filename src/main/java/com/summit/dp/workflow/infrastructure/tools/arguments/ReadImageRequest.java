package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/** {@code read_image} 的参数：V1 只接受一个工作区内路径。 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReadImageRequest {
    private String path;
}
