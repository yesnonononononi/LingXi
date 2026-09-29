package com.summit.dp.tools.baseTools.file.edit;

import com.github.difflib.DiffUtils;
import com.github.difflib.UnifiedDiffUtils;
import com.github.difflib.patch.Patch;
import com.summit.dp.tools.baseTools.file.record.Differ;
import com.summit.dp.tools.baseTools.file.record.DiffResult;
import lombok.extern.slf4j.Slf4j;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;


@Slf4j
public class EditDiffer implements Differ {

    public DiffResult diff(Path path, String newContent) {
        try {
            String oldContent = Files.readString(path);
            return diff(path.toString(),oldContent, newContent);
        } catch (Exception e) {
            return DiffResult.fail("diff failed"+e.getMessage());
        }

    }

    public DiffResult diff(String fileName,String oldContent, String newContent) {
        try {
            List<String> oldList = Arrays.stream(oldContent.split("\\R",-1)).collect(Collectors.toList());

            List<String> newList = Arrays.stream(newContent.split("\\R",-1)).collect(Collectors.toList());

            Patch<String> patch = DiffUtils.diff(oldList, newList);

            List<String> diff = UnifiedDiffUtils.generateUnifiedDiff(fileName, fileName, oldList, patch, 3);
            log.debug("edit_file diff on {}: {} unified diff lines", fileName, diff.size());
            return DiffResult.success(diff);

        } catch (Exception e) {
            return DiffResult.fail("diff failed"+e.getMessage());
        }
    }
}
