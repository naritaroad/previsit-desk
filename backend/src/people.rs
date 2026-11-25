//! `PersonRef` (contract §1): the short form of an account that other objects point at, in the reader's language.

use std::collections::HashMap;

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::perm::Role;
use crate::types::Locale;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PersonRef {
    pub id: Uuid,
    pub display_name: String,
    pub role: Role,
    pub title: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PersonRow {
    pub id: Uuid,
    pub display_name: String,
    pub display_name_en: Option<String>,
    #[sqlx(try_from = "String")]
    pub role: Role,
    pub title: Option<String>,
    pub title_en: Option<String>,
    pub avatar: Option<String>,
}

impl PersonRow {
    pub fn to_ref(&self, locale: Locale) -> PersonRef {
        let pick = |zh: Option<&String>, en: &Option<String>| {
            if locale.is_en() {
                en.as_ref().or(zh).cloned()
            } else {
                zh.cloned()
            }
        };
        PersonRef {
            id: self.id,
            display_name: pick(Some(&self.display_name), &self.display_name_en).unwrap_or_default(),
            role: self.role,
            title: pick(self.title.as_ref(), &self.title_en),
            avatar: self.avatar.clone(),
        }
    }
}

macro_rules! person_cols {
    () => {
        "id, display_name, display_name_en, role, title, title_en, avatar"
    };
}

/// Everyone in `ids`, keyed by id. Unknown ids are simply absent.
pub async fn load(
    db: &PgPool,
    ids: impl IntoIterator<Item = Uuid>,
    locale: Locale,
) -> sqlx::Result<People> {
    let mut wanted: Vec<Uuid> = ids.into_iter().collect();
    wanted.sort();
    wanted.dedup();
    if wanted.is_empty() {
        return Ok(People::default());
    }
    let rows: Vec<PersonRow> = sqlx::query_as(concat!(
        "SELECT ",
        person_cols!(),
        " FROM accounts WHERE id = ANY($1)"
    ))
    .bind(&wanted)
    .fetch_all(db)
    .await?;
    Ok(People(
        rows.into_iter().map(|r| (r.id, r.to_ref(locale))).collect(),
    ))
}

pub async fn one(db: &PgPool, id: Uuid, locale: Locale) -> sqlx::Result<Option<PersonRef>> {
    Ok(load(db, [id], locale).await?.get(Some(id)))
}

/// Active accounts of the given roles, by role then name ("assign to" lists).
pub async fn by_roles(db: &PgPool, roles: &[Role], locale: Locale) -> sqlx::Result<Vec<PersonRef>> {
    let names: Vec<&str> = roles.iter().map(|r| r.as_str()).collect();
    let rows: Vec<PersonRow> = sqlx::query_as(concat!(
        "SELECT ",
        person_cols!(),
        " FROM accounts WHERE role = ANY($1) AND status = 'active' ORDER BY array_position($1, role), display_name"
    ))
    .bind(&names)
    .fetch_all(db)
    .await?;
    Ok(rows.iter().map(|r| r.to_ref(locale)).collect())
}

#[derive(Debug, Default)]
pub struct People(HashMap<Uuid, PersonRef>);

impl People {
    pub fn get(&self, id: Option<Uuid>) -> Option<PersonRef> {
        id.and_then(|id| self.0.get(&id).cloned())
    }

    /// For fields the contract says are always present: a missing account shows as an unnamed patient.
    pub fn get_or_unknown(&self, id: Option<Uuid>, locale: Locale) -> PersonRef {
        self.get(id).unwrap_or_else(|| unknown_patient(locale))
    }
}

/// Stands in for the patient of a v1 visit, which has no account.
pub fn unknown_patient(locale: Locale) -> PersonRef {
    PersonRef {
        id: Uuid::nil(),
        display_name: crate::texts::t(crate::texts::T::UnknownPatient, locale).to_string(),
        role: Role::Patient,
        title: None,
        avatar: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_readers_language_and_fall_back() {
        let row = PersonRow {
            id: Uuid::nil(),
            display_name: "陳柏宇".into(),
            display_name_en: Some("Po-Yu Chen".into()),
            role: Role::Physician,
            title: Some("醫師".into()),
            title_en: None,
            avatar: None,
        };
        assert_eq!(row.to_ref(Locale::ZhTw).display_name, "陳柏宇");
        let en = row.to_ref(Locale::En);
        assert_eq!(en.display_name, "Po-Yu Chen");
        assert_eq!(en.title.as_deref(), Some("醫師"));
    }
}
