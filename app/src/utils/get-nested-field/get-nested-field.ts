import { useFieldsStore, useRelationsStore } from '@/stores';
import i18n from '@/lang';
const fieldsStore = useFieldsStore();
const relationsStore = useRelationsStore();

export default function getNestedField(item: object, path: string, collection: string): any {
	path = path.split('.');
	const pathBefore = [];
	while (path.length && item) {
		const key = path.shift();
		pathBefore.push(key);
		item = item[key];
		if (Array.isArray(item)) {
			const field = fieldsStore.getField(collection, pathBefore.join('.'));
			if (field.type === 'translations') {
				const relations = relationsStore.getRelationsForField(field.collection, field.field);
				const translationsRelation = relations.find(
					(relation) => relation.one_collection === field.collection && relation.one_field === field.field
				);
				const languagesCodeField = translationsRelation.junction_field;
				item = item.find((el) => el[languagesCodeField] === i18n.locale) || item[0];
			}
		}
	}
	return item;
}
