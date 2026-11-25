-- The confirmation of being 18 or older (required by the model provider's terms) is kept as a consent row.
ALTER TABLE consents DROP CONSTRAINT consents_doc_check;
ALTER TABLE consents ADD CONSTRAINT consents_doc_check CHECK (doc IN ('terms', 'ai_disclosure', 'rx_review', 'adult'));
