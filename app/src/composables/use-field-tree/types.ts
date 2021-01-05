import { TranslateResult } from 'vue-i18n';
import { Field } from '@/types';

export interface FieldTree extends Field {
	key: string;
	children?: FieldTree[];
}
