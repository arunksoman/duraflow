// Full class strings (not built by concatenation) so Tailwind's scanner picks them up.
const TINTS = [
	'bg-primary/10 text-primary',
	'bg-secondary/10 text-secondary',
	'bg-accent/15 text-accent',
	'bg-info/15 text-info',
	'bg-success/15 text-success',
	'bg-warning/15 text-warning'
];

/** A stable accent for an item's icon tile, so cards are told apart at a glance by more than name. */
export function tintFor(key: string): string {
	let hash = 0;
	for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
	return TINTS[Math.abs(hash) % TINTS.length];
}
