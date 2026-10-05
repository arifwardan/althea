<script>
  import { Select } from "bits-ui";
  import { cn } from "../../utils.js";

  let {
    value = $bindable(),
    options = [],
    placeholder = "Select…",
    label = "options",
    searchable = false,
    searchPlaceholder = "search…",
    class: className = "",
    ...rest
  } = $props();

  let open = $state(false);
  let query = $state("");
  let searchEl = $state(null);

  let filtered = $derived(
    !searchable || !query.trim()
      ? options
      : options.filter((o) =>
          `${o.label ?? ""} ${o.value ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
        ),
  );

  // Tiap dibuka: reset query + fokus ke kolom search (bila ada).
  $effect(() => {
    if (open) {
      query = "";
      if (searchable) requestAnimationFrame(() => searchEl?.focus({ preventScroll: true }));
    }
  });
</script>

<Select.Root bind:value bind:open type="single" {...rest}>
  <Select.Trigger
    class={cn(
      "flex h-8 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    aria-label={label}
  >
    <Select.Value {placeholder} class="truncate" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      class="z-50 flex max-h-72 min-w-36 flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground"
      sideOffset={4}
    >
      {#if searchable}
        <div class="shrink-0 border-b border-border p-1">
          <input
            bind:this={searchEl}
            bind:value={query}
            placeholder={searchPlaceholder}
            aria-label="search options"
            autocomplete="off"
            class="h-8 w-full rounded-sm bg-transparent px-2 text-sm text-white outline-none placeholder:text-muted-foreground"
            onkeydown={(e) => {
              if (e.key !== "Escape") e.stopPropagation();
            }}
          />
        </div>
      {/if}
      <div class="overflow-y-auto p-1">
        {#each filtered as o (o.value)}
          <Select.Item
            value={o.value}
            label={o.label}
            disabled={o.disabled}
            class="relative flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:font-medium"
          >
            {o.label}
          </Select.Item>
        {:else}
          <div class="px-2 py-1.5 text-sm text-muted-foreground">no match</div>
        {/each}
      </div>
    </Select.Content>
  </Select.Portal>
</Select.Root>
