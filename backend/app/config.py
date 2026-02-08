from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gemini_api_key: str = ""
    database_url: str = "postgresql+asyncpg://scout:scout@localhost:5432/scout"
    database_url_sync: str = "postgresql+psycopg2://scout:scout@localhost:5432/scout"
    # data.gov.sg API key (optional — higher rate limits)
    datagov_api_key: str = ""
    # Singapore government API keys (optional, for future premium endpoints)
    ura_access_key: str = ""
    lta_account_key: str = ""

    class Config:
        env_file = ".env"


settings = Settings()
