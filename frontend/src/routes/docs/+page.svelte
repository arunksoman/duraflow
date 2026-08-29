<script lang="ts">
	import { ArrowLeft, BookOpen } from '@lucide/svelte';
</script>

<svelte:head>
	<title>Docs · DuraFlow</title>
</svelte:head>

<div
	class="bg-base-100 flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center"
>
	<div class="bg-primary/10 text-primary rounded-xl p-3">
		<BookOpen size={28} />
	</div>
	<h1 class="text-2xl font-semibold">Documentation is on its way</h1>
	<p class="text-base-content/60 max-w-md">
		We're still writing the DuraFlow docs. In the meantime, jump into the app and start building —
		the canvas is more self-explanatory than you'd think.
	</p>
	<a href="/" class="btn btn-ghost btn-sm mt-2">
		<ArrowLeft size={16} />
		Back home
	</a>
</div>
