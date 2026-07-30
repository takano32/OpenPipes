# OpenPipes

[![test](https://github.com/takano32/OpenPipes/actions/workflows/test.yml/badge.svg)](https://github.com/takano32/OpenPipes/actions/workflows/test.yml)

Yahoo! Pipes クローンです。ブラウザ上のビジュアルエディタでフィード処理パイプライン(「パイプ」)を組み立て、サーバーサイドのエンジンで実行し、結果を RSS 2.0 / JSON として再配信できます。

- **依存パッケージゼロ** — Node.js >= 18 の標準機能のみ。フロントエンドも素の JS / CSS / HTML(CDN なし、ビルド不要)
- すべて ESM

## クイックスタート

```sh
node server.js
```

ブラウザで http://localhost:3000 を開きます。ポートは環境変数で変更できます: `PORT=8080 node server.js`

## 使い方

1. 左のパレットからモジュールをキャンバスへドラッグ&ドロップ
2. モジュール下端の出力ポートから、別モジュール上端の入力ポートへドラッグしてワイヤーを接続(データは上から下へ流れます。各入力ポートに繋げるワイヤーは 1 本まで)
3. **実行 ▶** で実行。各カードに件数バッジが付き、下部のデバッガパネルに選択中モジュールの出力(件数・各アイテム・JSON 表示)が表示されます
4. ユーザー入力モジュール(Text/Number/URL Input)を置くと、デバッガ上部にパラメータ入力欄が現れます。値はパイプ内の任意の文字列パラメータで `${name}` として参照できます
5. **保存** で保存(初回保存時にサーバーが id を割り当て)、**読み込み ▾** で保存済みパイプを読み込み。`http://localhost:3000/?pipe=<id>` で特定のパイプを直接開くこともできます
6. 選択したワイヤーやモジュールは Delete / Backspace で削除
7. キャンバス右下の ─ / % / + でズーム(40〜200%)。Ctrl+ホイール(Mac は Cmd)や Ctrl+`+` / `-` / `0` でも操作でき、パーセント表示をクリックすると 100% に戻ります
8. 操作は ↶ ↷ ボタンまたは Ctrl+Z / Ctrl+Shift+Z(Mac は Cmd)で元に戻す・やり直す(直近 60 状態を保持)。1 つのフィールドへの連続入力はまとめて 1 手として扱われます。テキスト入力中はブラウザ標準の取り消しが優先されるので、グラフを戻したいときは入力欄からフォーカスを外してください

### 保存したパイプの公開

保存後は `/pipes/<id>/run` で実行結果を取得できます。

- 既定(または `?format=rss`)で RSS 2.0、`?format=json` で `{ "items": [...] }`
- `format` 以外のクエリパラメータは `${name}` パラメータの上書きに使われます

例: `http://localhost:3000/pipes/demo-tech-filter/run?q=Rust&format=json`

## モジュール一覧(23 種)

| type | 名前 | カテゴリ | 説明 |
|------|------|----------|------|
| `fetch_feed` | Fetch Feed | Sources | 複数 URL の RSS / Atom / RDF を並列取得し、URL 順に連結。各アイテムに `source`(フィードタイトル)を付与 |
| `fetch_json` | Fetch JSON | Sources | JSON を取得し、ドットパス `path` で指した配列をアイテム化(オブジェクトは 1 件、スカラーは `{value}` に包む) |
| `item_builder` | Item Builder | Sources | 名前と値のペアからアイテムを 1 件生成(`a.b.c` のドット記法対応) |
| `text_input` | Text Input | User Inputs | `${name}` で参照できるテキストパラメータを宣言(ポートなし) |
| `number_input` | Number Input | User Inputs | 数値パラメータを宣言(ポートなし) |
| `url_input` | URL Input | User Inputs | URL パラメータを宣言(ポートなし) |
| `filter` | Filter | Operators | ルールに一致するアイテムを許可(permit)/遮断(block)。all / any 結合、contains・equals(大文字小文字無視)・正規表現・数値/日付比較に対応 |
| `sort` | Sort | Operators | 複数キーの安定ソート。数値・日付・文字列を自動判別、欠損値は常に末尾 |
| `truncate` | Truncate | Operators | 先頭 N 件を残す |
| `tail` | Tail | Operators | 末尾 N 件を残す |
| `unique` | Unique | Operators | 指定フィールドの値ごとに最初の 1 件を残して重複排除 |
| `reverse` | Reverse | Operators | 並び順を反転 |
| `union` | Union | Operators | 最大 5 入力(`in1`..`in5`)をポート順に連結 |
| `count` | Count | Operators | 件数を `{ "count": n }` の 1 アイテムとして出力 |
| `rename` | Rename | Operators | フィールドの移動(rename)または複製(copy) |
| `regex` | Regex | Operators | 正規表現でフィールド値を置換(`$1` 後方参照・フラグ対応) |
| `sub_element` | Sub-element | Operators | パスの値を新しいアイテム列に展開(配列は要素ごと、欠損アイテムは除去) |
| `string_builder` | String Builder | Operators | 複数のパーツを連結して指定フィールドに書き込む |
| `date_builder` | Date Builder | Operators | 日付フィールドを iso / rfc822 / date / datetime / epoch に整形 |
| `url_builder` | URL Builder | Operators | ベース URL にクエリパラメータを付けて組み立てる(値が空の行は出力しない) |
| `strip_html` | Strip HTML | Operators | 指定フィールドからタグを除去して実体参照を復元 |
| `loop` | Loop | Operators | 保存済みパイプをアイテムごとに実行(結果で置換、またはフィールドに格納) |
| `output` | Pipe Output | Output | パイプの最終結果。1 パイプに 1 つ |

String Builder と URL Builder の文字列では `{title}` や `{author.name}` と書くとアイテムのフィールドが差し込まれます(存在しなければ空文字、`{{` と `}}` は波括弧そのもの)。実行前に一度だけ置換されるパイプパラメータ `${name}` とは別物で、同じ文字列に混在させても干渉しません。

Yahoo! Pipes にあった Split は用意していません。出力ポートは元から好きなだけ分岐できるので、同じことができます。

### Loop(サブパイプ)

Loop は、入力アイテム 1 件ごとに保存済みパイプを実行します。アイテムのトップレベルの値がそのままサブパイプのパラメータになるので、サブパイプ側では `${link}` と書けば「そのアイテムの link」を指します。`mode` が `replace` ならアイテムをサブパイプの出力で置き換え、`assign` ならアイテムを残して `to` で指定したフィールドに結果の配列を入れます。

処理量が掛け算で増える唯一のモジュールなので、入れ子は 3 段まで、自分自身を呼ぶパイプは名前で拒否、サブパイプの同時実行は 4 本まで、`limit` を超えた分は黙って捨てずに警告として報告します。

## パイプ定義 JSON フォーマット

```json
{
  "name": "My pipe",
  "modules": [
    { "id": "m1", "type": "fetch_feed", "params": { "urls": ["/demo/tech.xml"] }, "x": 120, "y": 60 },
    { "id": "m2", "type": "output", "params": {}, "x": 140, "y": 400 }
  ],
  "wires": [
    { "id": "w1", "from": { "module": "m1", "port": "out" }, "to": { "module": "m2", "port": "in" } }
  ]
}
```

- `x` / `y` はキャンバス座標で、エンジンは無視します
- 入力ポートへのワイヤーは 1 本まで、出力ポートは自由に分岐できます
- 保存ファイル(`data/pipes/<id>.json`)は上記に `id` と `savedAt` が付いた形式です

## HTTP API

| メソッド | パス | 内容 |
|----------|------|------|
| GET | `/` | エディタページ |
| GET | `/editor.js`, `/editor.css` | `public/` 内の静的ファイル |
| GET | `/demo/<name>.xml` | 同梱デモフィード(`assets/demo/`) |
| GET | `/api/modules` | モジュールカタログ(JSON) |
| POST | `/api/run` | body `{ pipe, params? }` → `{ items, debug, errors }`(不正なパイプは 400 `{error}`) |
| GET | `/api/pipes` | 保存済みパイプ一覧 `[{ id, name, savedAt }]`(savedAt 降順) |
| POST | `/api/pipes` | body `{ id?, name, modules, wires }` → 保存して `{ id }` を返す |
| GET | `/api/pipes/:id` | 保存ファイルの JSON(存在しなければ 404 `{error}`) |
| DELETE | `/api/pipes/:id` | `{ ok: true }` |
| GET | `/pipes/:id/run` | 保存済みパイプを実行して RSS 2.0(`?format=json` で JSON)。`format` 以外のクエリはパイプパラメータになる |
| GET | `/api/config` | `{ readOnly, authRequired }`(常に認証不要) |

## デモパイプ

2 つのサンプルパイプが同梱されています(読み込み ▾ から開けます)。

- **デモ: テックニュース絞り込み** (`demo-tech-filter`) — デモフィード `/demo/tech.xml` を取得し、タイトルにキーワード `${q}`(既定 "AI")を含むアイテムだけを許可 → pubDate 降順ソート → 先頭 5 件 → 出力。`?q=Rust` のように URL からキーワードを差し替えられます
- **デモ: フィードのマージ** (`demo-merged`) — `/demo/tech.xml` と `/demo/world.xml` の 2 フィードを Union で連結し、タイトルで重複排除 → pubDate 降順ソート → 出力
- **デモ: Loop で各アイテムを加工** (`demo-loop`) — 2 フィードを取得 → 新着 6 件に絞り、Loop でサブパイプ `demo-headline` を 1 件ずつ適用してタイトルに配信元を付け日付を RFC 822 に整形 → 本文の HTML を除去 → 出力
- **デモ: 見出しを整える** (`demo-headline`) — 上の Loop から呼ばれるサブパイプ。単体で開くとパラメータ未指定なので空の見出しが 1 件出るだけです

## セキュリティ

パイプの URL はパイプを保存した人が決め、取得はサーバー側で行われます。そのままだとサーバーからしか見えない場所(`169.254.169.254` のクラウドメタデータ、LAN の管理画面、localhost の別サービス)への踏み台になるため、**公開ユニキャスト以外のアドレスへの取得は既定で拒否**します。IPv4 / IPv6 双方のループバック・プライベート・リンクローカル・キャリア NAT・マルチキャスト・予約範囲が対象で、`::ffff:` 形式や NAT64 形式も判定します。リダイレクト先も 1 ホップごとに検査するので、公開ホストが `302 http://169.254.169.254/` を返しても通り抜けられません。

例外は 2 つあります。1 つはアプリ自身のオリジンで、`/demo/tech.xml` のような相対 URL が同梱デモを取得できるのはこのためです。もう 1 つは環境変数で、社内フィードを集約するなど意図がある場合は `OPENPIPES_ALLOW_PRIVATE=1` で無効化できます。

なお、検査は接続前に行うため、検査時と接続時で名前解決の結果が変わる攻撃(DNS リバインディング)までは防げません。

### 認証と読み取り専用

どちらも既定では無効なので、手元で `node server.js` する分にはこれまでどおりです。

- `OPENPIPES_PASSWORD` を設定すると HTTP Basic 認証を要求します(ユーザー名は `OPENPIPES_USER`、既定 `admin`)。照合は SHA-256 を通してから行うので、長さや先頭一致が処理時間から漏れません
- `OPENPIPES_READONLY=1` は保存済みパイプを変更する操作(`POST /api/pipes` と `DELETE /api/pipes/:id`)を 403 で拒否します。パスワードの有無とは独立です

```sh
OPENPIPES_PASSWORD=秘密 OPENPIPES_READONLY=1 node server.js
```

パスワードを設定しても、**公開フィード `/pipes/<id>/run` と同梱デモ `/demo/*.xml` は認証不要のまま**です。前者は RSS リーダーがログインできないため、後者は相対 URL を使うパイプでサーバーが自分自身から取得するためで、ここを閉じると機能そのものが壊れます。エディタ本体と残りの `/api/*` は認証の内側に入ります。

読み取り専用のときはエディタの「保存」ボタンと読み込みメニューの削除ボタンが消えます。

## テスト

```sh
npm test
```

`test/run-tests.js` が実行されます。ネットワークアクセスは不要です(フィード取得はすべて偽の fetcher で差し替え)。

エディタはブラウザテストで検証します。

```sh
npm run test:e2e
```

`test/e2e/run.mjs` が専用ポートでサーバーを起動し、ヘッドレス Chromium を CDP で操作して実際に配置・結線・実行・Undo/Redo・保存/削除を行い、終了時に後片付けします。保存先は一時ディレクトリなので `data/pipes/` は汚れません。Chromium が PATH に無い場合は `CHROME_BIN` を指定してください。Node.js 22 以上が必要です(グローバル `WebSocket` を使うため)。

GitHub Actions では master への push と Pull Request のたびに、ユニットテストを Node.js 18 / 20 / 22 / 24 で、ブラウザテストを Node.js 24 で実行します(`.github/workflows/test.yml`)。
