# Replays the cases export.test.ts wrote through coelho's Elixir and reports
# every case where the output differs. Run it from a coelho checkout:
#
#   MIX_ENV=test mix run /path/to/coelho_ts/scripts/sanitize-parity/compare.exs /tmp/cases.json
#
# sanitize cases compare canonical bytes. markdown cases compare
# to_markdown's text, with one known difference: the TypeScript writer puts
# non-ASCII whitespace at the edge of a block as its entity (`&#160;`),
# which every CommonMark reader decodes to the same character, because
# JavaScript readers trim it otherwise. Those entities are decoded before
# comparing, and reported apart.
[path] = System.argv()
cases = path |> File.read!() |> JSON.decode!()
default = Coelho.Schema.default()
tables = Coelho.Schema.Default.build(tables: true)

decode_edges = fn text ->
  Regex.replace(~r/&#(\d+);/, text, fn whole, code ->
    char = <<String.to_integer(code)::utf8>>
    if String.match?(char, ~r/\A\s\z/u) and char not in [" ", "\t", "\n", "\r"], do: char, else: whole
  end)
end

results =
  for %{"kind" => kind, "name" => name, "input" => input, "expected" => expected} <- cases do
    actual =
      case kind do
        "sanitize" ->
          input |> Coelho.Document.sanitize(default) |> Coelho.Document.canonical()

        "markdown" ->
          {:ok, document} = Coelho.Document.validate(input, tables)
          Coelho.Markdown.to_markdown(document, tables)
      end

    cond do
      actual == expected -> :same
      kind == "markdown" and actual == decode_edges.(expected) -> :edge_entity
      true ->
        IO.puts("#{name}\n  input:      #{JSON.encode!(input)}\n  typescript: #{inspect(expected)}\n  elixir:     #{inspect(actual)}\n")
        :different
    end
  end

counts = Enum.frequencies(results)
IO.puts("#{counts[:same] || 0} of #{length(cases)} cases agree byte for byte")
IO.puts("#{counts[:edge_entity] || 0} differ only by edge whitespace written as an entity")
if (counts[:different] || 0) > 0, do: System.halt(1)
