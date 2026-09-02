# OpenPipes

[![test](https://github.com/takano32/OpenPipes/actions/workflows/test.yml/badge.svg)](https://github.com/takano32/OpenPipes/actions/workflows/test.yml)

Yahoo! Pipes クローンです。ブラウザ上のビジュアルエディタでフィード処理パイプライン(「パイプ」)を組み立て、サーバーサイドのエンジンで実行し、結果を RSS 2.0 / JSON として再配信できます。

- **依存パッケージゼロ** — Node.js >= 22.13 の標準機能のみ(保存には `node:sqlite` を使います)。フロントエンドも素の JS / CSS / HTML(CDN なし、ビルド不要)
- すべて ESM

## クイックスタート

```sh
node server.js
```

ブラウザで http://localhost:3000 を開きます。Node.js 22.13 以上が必要です(保存に使う `node:sqlite` がフラグなしで使える最初のバージョンです)。

初回起動時に `data/openpipes.db` が作られ、保存したパイプ・ユーザー・セッションはすべてここに入ります。置き場所を変えるには `OPENPIPES_DB=/var/lib/openpipes/openpipes.db` のように指定します(親ディレクトリは自動で作られます)。

以前のバージョンから上げる場合: **`data/pipes/*.json` は自動では移行されません**(旧 `OPENPIPES_DATA` も読まれなくなりました)。残しておきたいパイプがあれば、その JSON を手元に取っておいて、エディタの読み込み ▾ →「⭱ JSON を読み込む…」で入れ直してください。同梱デモの 4 件は `assets/demo/pipes/` に移り、組み込みパイプとして最初から一覧に出ます。

ポートは環境変数で変更できます: `PORT=8080 node server.js`。`PORT` が無ければ Pterodactyl 系のホスティングパネルが渡す `SERVER_PORT` を読み、どちらも無ければ 3000 です。待ち受けアドレスは既定で全インターフェースですが、前段にリバースプロキシがあるホスティングでループバックだけに閉じたいときは `OPENPIPES_HOST=127.0.0.1` を設定します。

公開 URL がホスト名と違う場合(リバースプロキシ配下や HTTPS 終端がある場合)は `OPENPIPES_BASE_URL=https://pipes.example.com` を設定します。配信するフィードのリンクと、パイプ内の相対 URL の解決先がこの URL になります。パス・クエリ・フラグメントの付いた値は起動時に拒否します。

### バックアップ

データベース 1 ファイルだけを保存すれば済みます。ただし**稼働したまま `openpipes.db` だけを `cp` してはいけません**。書き込みは WAL 側に溜まっているので、コピーは行が欠けるどころか**テーブルが 1 つも無いデータベース**になることがあります(実測)。次のどれかにしてください。

```sh
sqlite3 data/openpipes.db ".backup backup.db"                # sqlite3 コマンドがあるなら
node -e "new (require('node:sqlite').DatabaseSync)('data/openpipes.db').exec(\"VACUUM INTO 'backup.db'\")"
```

下の node ワンライナー(`VACUUM INTO`)は稼働中でも動くことを確認済みです。出力先が既にあるとエラーになるので、`openpipes-$(date +%F).db` のような名前にしてください。サーバーを止めてからファイルをコピーしてもかまいませんが、その場合は `data/openpipes.db-wal` と `-shm` も一緒にコピーしてください。

戻せることまで確かめておくと安心です。`OPENPIPES_DB=/path/to/backup.db PORT=3001 node server.js` で起動して、パイプが載っていることを見てから止めてください(`sessions` も同じファイルに入っているので、古いバックアップに戻すと全員ログインし直しになります)。

`OPENPIPES_DB` に相対パスを書くとプロセスのカレントディレクトリ基準で解決され、親ディレクトリも黙って作られます。systemd などから起動すると意図しない場所に空のデータベースができ、**エラーも出ないままパイプが消えたように見える**ので、本番では絶対パスにしてください。

## 使い方

1. 左のパレットからモジュールをキャンバスへドラッグ&ドロップ
2. モジュール下端の出力ポートから、別モジュール上端の入力ポートへドラッグしてワイヤーを接続(データは上から下へ流れます。各入力ポートに繋げるワイヤーは 1 本まで)
3. **実行 ▶** で実行。各カードに件数バッジが付き、下部のデバッガパネルに選択中モジュールの出力(件数・各アイテム・JSON 表示)が表示されます
4. ユーザー入力モジュール(Text/Number/URL Input)を置くと、デバッガ上部にパラメータ入力欄が現れます。値はパイプ内の任意の文字列パラメータで `${name}` として参照できます
5. **保存** で保存(初回保存時にサーバーが id を割り当て)、**読み込み ▾** で保存済みパイプを読み込み。`http://localhost:3000/?pipe=<id>` で特定のパイプを直接開くこともできます。読み込みメニューは自分のパイプが先、その下の「デモ」以下が組み込みのデモパイプです。デモは読み取り専用なので、開いてそのまま**保存**するとコピーとして保存されます(⧉ で複製してから開いても同じです)
6. 選択したワイヤーやモジュールは Delete / Backspace で削除
7. キャンバス右下の ─ / % / + でズーム(40〜200%)。Ctrl+ホイール(Mac は Cmd)や Ctrl+`+` / `-` / `0` でも操作でき、パーセント表示をクリックすると 100% に戻ります
8. ツールバーの ⇵(Ctrl+Shift+L)で自動整列。ワイヤーの向きに沿って上から下へ並べ直します
9. 右下のミニマップにパイプ全体と現在の表示範囲が出ます。クリックやドラッグでその位置へ移動できます
10. カードのヘッダを Shift(または Ctrl)+クリックで複数選択、何もない場所からドラッグすると範囲選択、Ctrl+A で全選択、Escape で選択解除。選択したカードのどれかをドラッグすると全部まとめて動きます
11. Ctrl+C / Ctrl+X / Ctrl+V でコピー・切り取り・貼り付け(ページ内でのみ有効)。両端が選択に含まれるワイヤーも一緒に複製されます
12. 操作は ↶ ↷ ボタンまたは Ctrl+Z / Ctrl+Shift+Z(Mac は Cmd)で元に戻す・やり直す(直近 60 状態を保持)。1 つのフィールドへの連続入力はまとめて 1 手として扱われます。テキスト入力中はブラウザ標準の取り消しが優先されるので、グラフを戻したいときは入力欄からフォーカスを外してください
13. Google ログインを有効にしてあるサーバーでは、最初にログイン画面が出ます。ログイン後は右上にアカウント名が並び、**ログアウト**で抜けられます(未保存の変更があるときは確認します)

### 保存したパイプの公開

保存後は `/pipes/<id>/run` で実行結果を取得できます。

- 既定(または `?format=rss`)で RSS 2.0、`?format=json` で `{ "items": [...] }`、`?format=jsonfeed` で [JSON Feed 1.1](https://jsonfeed.org/version/1.1)
- `format` 以外のクエリパラメータは `${name}` パラメータの上書きに使われます

例: `http://localhost:3000/pipes/demo-tech-filter/run?q=Rust&format=json`

## モジュール一覧(25 種)

| type | 名前 | カテゴリ | 説明 |
|------|------|----------|------|
| `fetch_feed` | Fetch Feed | Sources | 複数 URL の RSS / Atom / RDF を並列取得し、URL 順に連結。各アイテムに `source`(フィードタイトル)を付与 |
| `fetch_json` | Fetch JSON | Sources | JSON を取得し、ドットパス `path` で指した配列をアイテム化(オブジェクトは 1 件、スカラーは `{value}` に包む) |
| `fetch_page` | Fetch Page | Sources | HTML ページを CSS セレクタでスクレイピングしてアイテム化 |
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
| `term_extractor` | Term Extractor | Operators | 本文から特徴的な語を抽出して配列で格納(日本語対応) |
| `loop` | Loop | Operators | 保存済みパイプをアイテムごとに実行(結果で置換、またはフィールドに格納) |
| `output` | Pipe Output | Output | パイプの最終結果。1 パイプに 1 つ |

String Builder と URL Builder の文字列では `{title}` や `{author.name}` と書くとアイテムのフィールドが差し込まれます(存在しなければ空文字、`{{` と `}}` は波括弧そのもの)。実行前に一度だけ置換されるパイプパラメータ `${name}` とは別物で、同じ文字列に混在させても干渉しません。

Yahoo! Pipes にあった Split は用意していません。出力ポートは元から好きなだけ分岐できるので、同じことができます。

### Fetch Page(スクレイピング)

RSS を出していないサイトからフィードを作るためのモジュールです。`item` に繰り返し要素の CSS セレクタ(例 `article.post`)を書くと、一致した要素ごとに 1 アイテムを作ります。空にするとページ全体で 1 アイテムです。

各フィールド行は「取り出す名前 / その要素内を探すセレクタ / 取り出す値」の 3 つで、値は `text`(空白を詰めたテキスト)、`html`(内側のマークアップ)、または属性名を指定します。`href` `src` `poster` `data-src` はページの URL を基準に絶対 URL へ直します(配信先で読まれるため)。セレクタが何にも当たらなかった行は、そのアイテムから省かれます。

対応するセレクタは、タグ・`.class`・`#id`・`[attr]` と `= ^= $= *= ~= |=`・子孫・`>`・カンマ区切りです。`:hover` のような未対応の記法は黙って誤選択せずエラーにします。

### Term Extractor(キーワード抽出)

本文から特徴的な語を取り出して配列フィールドに入れます。英語は単語で区切り、3 文字未満と簡単なストップワードを落とします。日本語は空白がないので、**ひらがなを区切りとして扱い**、漢字・カタカナの複合語だけを残します(助詞や活用はひらがな側に落ちるため)。頻度、次に語長で並べます。

例: 「人工知能の研究が進み、人工知能を使った開発支援ツールが増えている。」→ `["人工知能", "開発支援ツール", "研究", ...]`

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
- 保存したパイプは上記に `id` と `savedAt` が付いた形になり、`data/openpipes.db`(SQLite)の中に入ります。読み込みメニューの「JSON を書き出す / 読み込む」で、この形のファイルとやり取りできます
- `id` は名前を ascii に潰したもの(40 文字まで)+ `-` + 16 桁の 16 進数です。公開フィード URL には id しか入らないので、**id を知っていることがそのフィードを読める資格**になります(パイプの中に非公開の取得先 URL が入っていることがあるため、推測できない長さにしてあります)

## HTTP API

| メソッド | パス | 内容 |
|----------|------|------|
| GET | `/` | エディタページ |
| GET | `/editor.js`, `/editor.css` | `public/` 内の静的ファイル |
| GET | `/demo/<name>.xml` | 同梱デモフィード(`assets/demo/`) |
| GET | `/api/modules` | モジュールカタログ(JSON) |
| POST | `/api/run` | body `{ pipe, params? }` → `{ items, debug, errors }`(不正なパイプは 400 `{error}`) |
| GET | `/api/pipes` | パイプ一覧 `[{ id, name, savedAt, readOnly }]`(自分のパイプが savedAt 降順、その後にデモ) |
| POST | `/api/pipes` | body `{ id?, name, modules, wires }` → 保存して `{ id }` を返す。`id` 無しなら新規作成、`id` 付きは更新なのでデモは 403、自分のものでない id は 404 |
| GET | `/api/pipes/:id` | パイプの JSON + `readOnly`(存在しない・自分のものでなければ 404 `{error}`) |
| DELETE | `/api/pipes/:id` | `{ ok: true }`(デモは 403)。存在しない id や他人の id でも 200 を返します(冪等な削除。他人のパイプの有無を漏らさないため)。消えたかどうかは直後の `GET` か一覧で確認してください |
| GET | `/pipes/:id/run` | 保存済みパイプを実行して RSS 2.0(`?format=json` で素の JSON、`?format=jsonfeed` で JSON Feed 1.1)。`format` 以外のクエリはパイプパラメータになる。認証不要 |
| GET | `/api/config` | `{ readOnly, auth, user }`(常に認証不要)。`auth` は `none` / `basic` / `google`、`user` は Google ログイン中のみ `{ name, email, picture }` |
| GET | `/auth/google/login` | Google ログイン開始(`?return_to=<パス>`)。Google モードのみ、他モードでは 404 |
| GET | `/auth/google/callback` | Google からの戻り先。失敗時は JSON ではなく HTML のエラーページ |
| POST | `/auth/logout` | セッションを破棄して 204。Google モードのみ |

`/api/*` は未ログインだと 401 を返します(Basic 認証時は `WWW-Authenticate` 付き、Google ログイン時は付けずに `{"error":"Sign in required"}`)。読み取り専用インスタンスへの書き込み、デモの上書き・削除は 403、他人のパイプは存在しないものとして 404 です。

## デモパイプ

4 つのサンプルパイプが同梱されています(読み込み ▾ から開けます)。中身は `assets/demo/pipes/*.json` で、データベースではなくファイルとして読み込まれる **組み込みパイプ**です。誰から見ても同じものが一覧に出て、**読み取り専用**なので上書き保存も削除もできません(それぞれ 403)。手を入れたいときは読み込みメニューの ⧉ で複製すると、自分のパイプになります。

- **デモ: テックニュース絞り込み** (`demo-tech-filter`) — デモフィード `/demo/tech.xml` を取得し、タイトルにキーワード `${q}`(既定 "AI")を含むアイテムだけを許可 → pubDate 降順ソート → 先頭 5 件 → 出力。`?q=Rust` のように URL からキーワードを差し替えられます
- **デモ: フィードのマージ** (`demo-merged`) — `/demo/tech.xml` と `/demo/world.xml` の 2 フィードを Union で連結し、タイトルで重複排除 → pubDate 降順ソート → 出力
- **デモ: Loop で各アイテムを加工** (`demo-loop`) — 2 フィードを取得 → 新着 6 件に絞り、Loop でサブパイプ `demo-headline` を 1 件ずつ適用してタイトルに配信元を付け日付を RFC 822 に整形 → 本文の HTML を除去 → 出力
- **デモ: 見出しを整える** (`demo-headline`) — 上の Loop から呼ばれるサブパイプ。単体で開くとパラメータ未指定なので空の見出しが 1 件出るだけです

## セキュリティ

パイプの URL はパイプを保存した人が決め、取得はサーバー側で行われます。そのままだとサーバーからしか見えない場所(`169.254.169.254` のクラウドメタデータ、LAN の管理画面、localhost の別サービス)への踏み台になるため、**公開ユニキャスト以外のアドレスへの取得は既定で拒否**します。IPv4 / IPv6 双方のループバック・プライベート・リンクローカル・キャリア NAT・マルチキャスト・予約範囲が対象で、`::ffff:` 形式や NAT64 形式も判定します。リダイレクト先も 1 ホップごとに検査するので、公開ホストが `302 http://169.254.169.254/` を返しても通り抜けられません。

例外は 2 つあります。1 つはアプリ自身のオリジンで、`/demo/tech.xml` のような相対 URL が同梱デモを取得できるのはこのためです。もう 1 つは環境変数で、社内フィードを集約するなど意図がある場合は `OPENPIPES_ALLOW_PRIVATE=1` で無効化できます。

なお、検査は接続前に行うため、検査時と接続時で名前解決の結果が変わる攻撃(DNS リバインディング)までは防げません。

### 配信結果のキャッシュ

`/pipes/<id>/run` は購読者ごとに定期的に叩かれ、その都度パイプが指す取得先を全部読みに行きます。負荷を上流に転嫁しないよう、レンダリング済みの結果を既定 300 秒メモリにキャッシュします(`OPENPIPES_CACHE_TTL` 秒で変更、`0` で無効)。

キーにはパイプの `savedAt` が入っているので、パイプを保存し直せば自動的に無効化されます。クエリ文字列と `Host` も別扱いです。エラーになった実行結果はキャッシュしません。

すべての応答に `ETag` が付き、`If-None-Match` には 304 を返します。RSS リーダーの転送量を実際に減らすのはこちらです。`Cache-Control: no-cache` を送れば再計算します。どちらだったかは `X-OpenPipes-Cache: hit|miss` で分かります。エディタの「実行」が使う `/api/run` はキャッシュしません。

### 認証と読み取り専用

どちらも既定では無効なので、手元で `node server.js` する分にはこれまでどおりです。

- `OPENPIPES_PASSWORD` を設定すると HTTP Basic 認証を要求します(ユーザー名は `OPENPIPES_USER`、既定 `admin`)。照合は SHA-256 を通してから行うので、長さや先頭一致が処理時間から漏れません
- `OPENPIPES_READONLY=1` は保存済みパイプを変更する操作(`POST /api/pipes` と `DELETE /api/pipes/:id`)を 403 で拒否します。パスワードの有無とは独立です

```sh
OPENPIPES_PASSWORD=秘密 OPENPIPES_READONLY=1 node server.js
```

パスワードを設定しても、**公開フィード `/pipes/<id>/run` と同梱デモ `/demo/*.xml` は認証不要のまま**です。前者は RSS リーダーがログインできないため、後者は相対 URL を使うパイプでサーバーが自分自身から取得するためで、ここを閉じると機能そのものが壊れます。エディタ本体と残りの `/api/*` は認証の内側に入ります。

読み取り専用のときはエディタの「保存」ボタンと読み込みメニューの複製・削除ボタンが消えます。

## Google ログイン

Google アカウントでログインさせ、**ユーザーごとにパイプを分ける**モードです。環境変数を設定すると有効になります。Basic 認証(`OPENPIPES_PASSWORD`)との併用はできず、両方設定すると起動時にエラーで止まります。

### Google Cloud Console での準備

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作る(既にあるならそれで可)
2. 「API とサービス」→「OAuth 同意画面」を設定する(アプリ名、サポートメール。スコープは `openid` `email` `profile` だけです)
3. **同意画面の公開ステータスとテストユーザーを決める**(ここが一番の落とし穴。下記)
4. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ アプリケーションの種類は**ウェブ アプリケーション**
5. 「承認済みのリダイレクト URI」に `<OPENPIPES_BASE_URL>/auth/google/callback` を**完全一致**で登録する(例: `https://pipes.example.com/auth/google/callback`)
6. 発行されたクライアント ID とクライアント シークレットを環境変数に入れる

#### 公開ステータスとテストユーザー

同意画面は作った直後は「テスト中」で、**テストユーザーに追加したアカウントしかログインできません**。自分自身も追加が必要です。追加していないアカウントでログインしようとすると Google 側で弾かれ、OpenPipes には「Google からエラーが返されました: access_denied」としか出ません。設定は合っているのに入れない、という状況の大半はこれです。

個人の Gmail アカウントで作ったプロジェクトでは「内部」を選べません(Google Workspace 組織のアカウントだけです)。自分以外にも使わせるなら「本番」に切り替えてください。OpenPipes が要求する `openid` `email` `profile` は機微スコープではないので通常は審査なしで公開できますが、承認済みドメインの登録や所有権の確認を求められることがあります。Console の表示に従ってください。

#### リダイレクト URI の完全一致

スキーム(http / https)・ホスト名・ポート番号・パス・末尾スラッシュのどれか 1 文字でも違うと `redirect_uri_mismatch` になります。しかもこのエラーは **Google の画面に出るだけでサーバーのログには何も残りません**(ログが無いから設定は正しい、と誤診しやすいところです)。

登録する文字列は推測せず、実際にサーバーが Google に送る値をそのままコピーしてください。

```sh
curl -s -o /dev/null -D - http://localhost:3000/auth/google/login | grep -i '^location:'
```

`Location:` の中の `redirect_uri=` がその文字列です(URL エンコードされているので戻して読んでください)。`curl -I` は HEAD リクエストになり、このサーバーは GET しか受け付けないので全パス 404 になります。使わないでください。

`http` が使えるのは **localhost と 127.0.0.1 だけ**です。手元で試すなら `OPENPIPES_BASE_URL=http://localhost:3000` で構いませんが、LAN の IP・社内ホスト名・本番ドメインはすべて https が必須で、http のままでは Console 側が登録を拒否します。

### 環境変数

| 変数 | 内容 |
|------|------|
| `OPENPIPES_GOOGLE_CLIENT_ID` | OAuth クライアント ID。これかシークレットのどちらかを設定すると Google モードになります |
| `OPENPIPES_GOOGLE_CLIENT_SECRET` | クライアント シークレット(PKCE を使っていても Google はトークンエンドポイントで要求します) |
| `OPENPIPES_BASE_URL` | 公開 URL。Google モードでは必須 |
| `OPENPIPES_ALLOWED_USERS` | 任意。ログインできるアカウントの制限(下記) |
| `OPENPIPES_OIDC_ISSUER` | 既定 `https://accounts.google.com`。他の OpenID Connect プロバイダも使えます(画面の文言は Google のままです) |

```sh
OPENPIPES_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com \
OPENPIPES_GOOGLE_CLIENT_SECRET=yyy \
OPENPIPES_BASE_URL=https://pipes.example.com \
node server.js
```

3 つのうち一部しか設定されていない場合は、どの変数が足りないかを表示して起動を拒否します。

クライアント シークレットをコマンドラインに直書きすると、シェルの履歴・`ps` の出力・`/proc/<pid>/environ` に残ります。本番では `chmod 600` したファイルに置いて、systemd なら `EnvironmentFile=` で読ませてください。リポジトリには入れないこと。漏れた場合は Console でローテートしてサーバーを再起動します(環境変数は起動時にしか読みません)。シークレットが使われるのはログイン時のトークンエンドポイントだけで、OpenPipes はリフレッシュトークンを持ちません。

### 誰がログインできるか

`OPENPIPES_ALLOWED_USERS` が**未設定なら、Google アカウントを持つ誰でもログインできます**(起動時にその旨を表示します)。制限するときはカンマ区切りで、メールアドレスかドメインを書きます。

```sh
OPENPIPES_ALLOWED_USERS='alice@example.com, @example.com'
```

`@example.com` はそのドメインの全員という意味です。大文字小文字は区別しません。照合には id_token の**確認済み**メールアドレスを使うので、`email_verified` が false のアカウントは許可リストに一致しても入れません。

**公開ホストに出すなら設定してください。** 未設定は「Google アカウントを持つ世界中の誰でもログインでき、あなたのサーバーにパイプを保存できる」という意味です。パイプの取得先はサーバーが読みに行くので、放置すると他人のフィード取得の踏み台にもなります。

### 動作確認

本物の Google を用意する前に、同梱の偽プロバイダでログイン一式を試せます。リポジトリの**外**に次の 1 ファイルを置いて起動してください。

```js
// ~/tmp/op-verify/issuer.mjs
import { startFakeIssuer } from 'file:///path/to/OpenPipes/test/fake-issuer.mjs';
const issuer = await startFakeIssuer({ clientId: 'test', clientSecret: 'test-secret' });
if (process.env.USER_JSON) issuer.setUser(JSON.parse(process.env.USER_JSON));
console.log(issuer.issuer);
```

```sh
USER_JSON='{"sub":"u1","email":"you@example.com","email_verified":true,"name":"テスト"}' node ~/tmp/op-verify/issuer.mjs &
# 表示された URL を OPENPIPES_OIDC_ISSUER に渡す
OPENPIPES_GOOGLE_CLIENT_ID=test OPENPIPES_GOOGLE_CLIENT_SECRET=test-secret \
OPENPIPES_BASE_URL=http://127.0.0.1:3000 \
OPENPIPES_OIDC_ISSUER=http://127.0.0.1:<偽 issuer のポート> \
OPENPIPES_DB=~/tmp/op-verify/t.db \
node server.js
```

ブラウザで `http://127.0.0.1:3000`(`OPENPIPES_BASE_URL` と同じ表記で)を開けばログイン画面から一周できます。`USER_JSON` を変えて issuer を再起動すれば別ユーザーになるので、パイプが互いに見えないことも確認できます。`OPENPIPES_ALLOWED_USERS` を設定して許可外のアドレスで弾かれるところまで、ここで見ておけます。

`npm test` と `npm run test:e2e` も同じ偽プロバイダを使ってログイン往復・ユーザー分離・CSRF・ログアウトまで自動で確認します。

### 覚えておくこと

- `OPENPIPES_BASE_URL` は**ブラウザで実際に使う URL** でなければなりません。書き込み系リクエストの `Origin` ヘッダをこの値と比較する CSRF 対策が入っているため、別のホスト名でアクセスすると保存が 403 になります
- リバースプロキシの下では、`OPENPIPES_BASE_URL` に公開 URL を、`OPENPIPES_HOST=127.0.0.1` に待ち受けアドレスを設定します
- セッションは 30 日で切れます(延長はしません)。Cookie は `HttpOnly` / `SameSite=Lax`、`OPENPIPES_BASE_URL` が https なら `Secure` も付きます。データベースに入るのは Cookie の値そのものではなく SHA-256 なので、データベースを持ち出しても使えるログイン状態にはなりません
- **パイプはユーザーごとに完全に分かれます**。一覧にも出ず、id を直接指定しても 404 です。ただし公開フィード `/pipes/<id>/run` は誰でも読めます — id を知っていることが読める資格なので、**id は秘密として扱ってください**
- Loop から呼べるサブパイプも、そのパイプの持ち主のものと組み込みデモだけです
- ユーザーの同一性は id_token の `sub` で決まり、メールアドレスでは決まりません。メールアドレスを変えてもパイプは残りますが、Google 側で `sub` が変わる状況(アカウントを消して作り直した等)では別人扱いになり、一覧が空になります(データベースには残っています)。逆に `OPENPIPES_ALLOWED_USERS` はメールアドレスで照合するので、メールを変えると急にログインできなくなることがあります
- モードを切り替えると、ログイン無しで動かしていたときの `local` ユーザーのパイプは見えなくなります(消えるわけではなく、Google モードでは別の持ち主として扱われます)。引き継ぎたい場合は `UPDATE pipes SET owner_id = '<新しいユーザー id>' WHERE owner_id = 'local'` のようにデータベースを直接書き換えるしかありません(ユーザー id は `SELECT id, email FROM users` で分かります)
- 認証まわりでサーバーが出すログは `login <ユーザー id>` と `logout <ユーザー id>` の 2 行だけです。トークン・認可コード・Cookie・メールアドレスはログに出しません
- 実際の Google を相手にした確認は、本物のクライアント ID を用意して一度やってみてください。テストは偽のプロバイダを相手にしているので、Google 固有の挙動までは保証できません

## テスト

```sh
npm test
```

`test/run-tests.js` が実行されます。ネットワークアクセスは不要です(フィード取得はすべて偽の fetcher で差し替え)。

エディタはブラウザテストで検証します。

```sh
npm run test:e2e
```

`test/e2e/run.mjs` が専用ポートでサーバーを起動し、ヘッドレス Chromium を CDP で操作して実際に配置・結線・実行・Undo/Redo・保存/削除を行い、終了時に後片付けします。保存先は `:memory:` のデータベースなので `data/openpipes.db` は汚れません。Chromium が PATH に無い場合は `CHROME_BIN` を指定してください。一式で数分かかるので、触ったところだけ試したいときは `E2E_ONLY='saved pipes' npm run test:e2e` のようにスイート名の一部を指定できます。

GitHub Actions では main への push と Pull Request のたびに、ユニットテストを Node.js 22 / 24 で、ブラウザテストを Node.js 24 で実行します(`.github/workflows/test.yml`)。
