class ConfigNotFoundException(Exception):
    def __init__(self):
        super().__init__("The 'baseUrl' and 'key' are not found in '.env' or OS variables")