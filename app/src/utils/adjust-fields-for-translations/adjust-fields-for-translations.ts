import { useFieldsStore, useRelationsStore } from '@/stores';
import { Field } from '@/types/';

const fieldsStore = useFieldsStore();
const relationsStore = useRelationsStore();

export default function adjustFieldsForTranslations(fields: readonly string[], parentCollection: string) {
	const adjustedFields: string[] = [...fields];

	fields.forEach((fieldKey) => {
		const path = fieldKey.split('.');

		for (let i = 1; i < path.length; i++) {
			const partialKey = path.slice(0, i).join('.');
			const field: Field = fieldsStore.getField(parentCollection, partialKey);

			if (!field) continue;

			if (field.type === 'translations') {
				const relations = relationsStore.getRelationsForField(field.collection, field.field);
				const translationsRelation = relations.find(
					(relation) => relation.one_collection === field.collection && relation.one_field === field.field
				);
				if (!translationsRelation) continue;
				const languagesCodeField = translationsRelation.junction_field;

				const languagesCodeKey = `${partialKey}.${languagesCodeField}`;
				if (!adjustedFields.includes(languagesCodeKey)) {
					adjustedFields.push(languagesCodeKey);
				}
			}
		}
	});

	return adjustedFields;
}
