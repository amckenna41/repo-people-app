from __future__ import annotations
from typing import Any, Optional
from pydantic import BaseModel, Field, field_validator

# GitHub owner/repo names: alphanumeric, hyphens, dots, underscores — 1–100 chars.
_GITHUB_NAME_PATTERN = r'^[a-zA-Z0-9._-]+$'


class FetchRequest(BaseModel):
    owner: str = Field(..., min_length=1, max_length=100, pattern=_GITHUB_NAME_PATTERN)
    repo: str = Field(..., min_length=1, max_length=100, pattern=_GITHUB_NAME_PATTERN)
    # Token is now sent via Authorization: Bearer header — removed from body (S1).
    roles: Optional[list[str]] = None
    limit: Optional[int] = Field(default=None, ge=1)
    exclude_bots: bool = False
    include_social_accounts: bool = False
    workers: int = Field(default=5, ge=1, le=20)  # S4: cap worker count
    save_each_user: bool = False


class RenameJobRequest(BaseModel):
    label: str = Field(..., min_length=1, max_length=120)


class TagsRequest(BaseModel):
    tags: list[str] = Field(default_factory=list)

    @field_validator('tags')
    @classmethod
    def validate_tags(cls, v: list[str]) -> list[str]:
        if len(v) > 10:
            raise ValueError('Maximum 10 tags allowed')
        for tag in v:
            if len(tag.strip()) > 50:
                raise ValueError('Each tag must be at most 50 characters')
        return v


class CompareRequest(BaseModel):
    job_id_a: str
    job_id_b: str


class MultiCompareRequest(BaseModel):
    job_ids: list[str]


class JobStatus(BaseModel):
    job_id: str
    status: str  # "pending" | "running" | "done" | "error"
    message: Optional[str] = None
    total_fetched: int = 0
    result: Optional[dict[str, Any]] = None
