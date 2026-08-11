"""migrate_weightkg_to_effort_weight

Revision ID: f4c7a1d9b2e0
Revises: e21a7c59b8d4
Create Date: 2026-04-29 00:00:00.000000
"""

from alembic import op


# revision identifiers, used by Alembic.
revision = "f4c7a1d9b2e0"
down_revision = "e21a7c59b8d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Orders: move legacy base_data.weight_kg to base_data.effort_weight when effort is missing.
    op.execute(
        """
        UPDATE orders
        SET base_data = (base_data - 'weight_kg') || jsonb_build_object('effort_weight', base_data->'weight_kg')
        WHERE base_data IS NOT NULL
          AND base_data ? 'weight_kg'
          AND NOT (base_data ? 'effort_weight');
        """
    )

    # Saved filters: migrate legacy filter field key.
    op.execute(
        """
        UPDATE saved_filters
        SET criteria = jsonb_set(criteria, '{task_filter_field}', '"effort_weight"', false)
        WHERE criteria->>'task_filter_field' = 'weight_kg';
        """
    )

    # Saved filters: migrate nested task_filters[].field values.
    op.execute(
        """
        UPDATE saved_filters
        SET criteria = jsonb_set(
            criteria,
            '{task_filters}',
            (
                SELECT COALESCE(
                    jsonb_agg(
                        CASE
                            WHEN elem->>'field' = 'weight_kg'
                                THEN jsonb_set(elem, '{field}', '"effort_weight"', false)
                            ELSE elem
                        END
                    ),
                    '[]'::jsonb
                )
                FROM jsonb_array_elements(COALESCE(criteria->'task_filters', '[]'::jsonb)) AS elem
            ),
            true
        )
        WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(criteria->'task_filters', '[]'::jsonb)) AS elem
            WHERE elem->>'field' = 'weight_kg'
        );
        """
    )


def downgrade() -> None:
    # Orders: map back effort_weight to weight_kg for rollback.
    op.execute(
        """
        UPDATE orders
        SET base_data = (base_data - 'effort_weight') || jsonb_build_object('weight_kg', base_data->'effort_weight')
        WHERE base_data IS NOT NULL
          AND base_data ? 'effort_weight'
          AND NOT (base_data ? 'weight_kg');
        """
    )

    op.execute(
        """
        UPDATE saved_filters
        SET criteria = jsonb_set(criteria, '{task_filter_field}', '"weight_kg"', false)
        WHERE criteria->>'task_filter_field' = 'effort_weight';
        """
    )

    op.execute(
        """
        UPDATE saved_filters
        SET criteria = jsonb_set(
            criteria,
            '{task_filters}',
            (
                SELECT COALESCE(
                    jsonb_agg(
                        CASE
                            WHEN elem->>'field' = 'effort_weight'
                                THEN jsonb_set(elem, '{field}', '"weight_kg"', false)
                            ELSE elem
                        END
                    ),
                    '[]'::jsonb
                )
                FROM jsonb_array_elements(COALESCE(criteria->'task_filters', '[]'::jsonb)) AS elem
            ),
            true
        )
        WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(criteria->'task_filters', '[]'::jsonb)) AS elem
            WHERE elem->>'field' = 'effort_weight'
        );
        """
    )
