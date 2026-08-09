import dataclasses
from typing import Optional


@dataclasses.dataclass
class Result:
    code:int
    message:str
    data:Optional[object]

    @staticmethod
    def success(data,code:int = 1):
        return Result(code, "success", data)

    @staticmethod
    def successWithoutParam():
        return Result(1, "success", None)

    @staticmethod
    def error(errmsg:str,code:int = 0):
        return Result(code, errmsg, None)

    @staticmethod
    def errorWithoutParam():
        return Result(0,"系统繁忙",None)

    def isOk(self):
        return self.code == 1
    def isFailed(self):
        return self.code == 0