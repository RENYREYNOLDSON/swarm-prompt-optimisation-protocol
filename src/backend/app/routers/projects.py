from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from psycopg import Connection
from pydantic import BaseModel, Field

from app.auth import CurrentUser
from app.db import db_conn

router = APIRouter(prefix="/api/projects", tags=["projects"])


ProjectStatus = Literal["pending", "generating", "ready", "failed"]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    domain: str = Field(min_length=1, max_length=500)
    difficulty: int = Field(default=5, ge=1, le=10)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    domain: str | None = Field(default=None, min_length=1, max_length=500)
    difficulty: int | None = Field(default=None, ge=1, le=10)


class Project(BaseModel):
    id: UUID
    name: str
    domain: str
    difficulty: int
    status: ProjectStatus
    created_at: datetime
    updated_at: datetime


@router.post("", response_model=Project, status_code=201)
def create_project(
    body: ProjectCreate,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> Project:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO projects (user_id, name, domain, difficulty)
            VALUES (%s, %s, %s, %s)
            RETURNING id, name, domain, difficulty, status, created_at, updated_at
            """,
            (user_id, body.name, body.domain, body.difficulty),
        )
        row = cur.fetchone()
    conn.commit()
    return Project(**row)


@router.get("", response_model=list[Project])
def list_projects(
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> list[Project]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, name, domain, difficulty, status, created_at, updated_at
            FROM projects
            WHERE user_id = %s
            ORDER BY created_at DESC
            """,
            (user_id,),
        )
        rows = cur.fetchall()
    return [Project(**r) for r in rows]


@router.get("/{project_id}", response_model=Project)
def get_project(
    project_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> Project:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, name, domain, difficulty, status, created_at, updated_at
            FROM projects
            WHERE id = %s AND user_id = %s
            """,
            (project_id, user_id),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return Project(**row)


@router.patch("/{project_id}", response_model=Project)
def update_project(
    project_id: UUID,
    body: ProjectUpdate,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> Project:
    sets: list[str] = []
    params: list[object] = []
    if body.name is not None:
        sets.append("name = %s")
        params.append(body.name)
    if body.domain is not None:
        sets.append("domain = %s")
        params.append(body.domain)
    if body.difficulty is not None:
        sets.append("difficulty = %s")
        params.append(body.difficulty)
    if not sets:
        raise HTTPException(status_code=400, detail="No fields to update")
    sets.append("updated_at = now()")
    params.extend([project_id, user_id])

    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE projects
            SET {', '.join(sets)}
            WHERE id = %s AND user_id = %s
            RETURNING id, name, domain, difficulty, status, created_at, updated_at
            """,
            tuple(params),
        )
        row = cur.fetchone()
    conn.commit()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return Project(**row)


@router.delete("/{project_id}", status_code=204, response_model=None)
def delete_project(
    project_id: UUID,
    user_id: CurrentUser,
    conn: Connection = Depends(db_conn),
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM projects WHERE id = %s AND user_id = %s",
            (project_id, user_id),
        )
        deleted = cur.rowcount
    conn.commit()
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Project not found")
