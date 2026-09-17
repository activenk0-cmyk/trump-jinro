# トランプ人狼（完全Webモード）

2人用の非対称情報心理戦カードゲーム「トランプ人狼」を、Vite + Firebase Firestore（リアルタイム同期）で実装したWebアプリです。

## 技術スタック
- フロントエンド：Vite + Tailwind CSS
- バックエンド：Firebase Cloud Firestore（`onSnapshot`によるリアルタイム同期）
- ホスティング：Vercel

## 遊び方
1. 片方の端末で「部屋を作る」を押し、表示されたルームIDをもう片方に共有する。
2. もう片方の端末で「部屋に入る」からそのIDを入力して入室する。
3. 設定を確認し「ゲーム開始」で対戦スタート。

## クレジット
本作のカード画像はGrokを使用して生成しました (Created with Grok)
