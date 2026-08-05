import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import Security

private func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

private func appleScriptString(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
}

private struct LanguageOption {
    let code: String
    let name: String
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private let ownerTokenKeychainService = "dev.chatgpttocodex.owner-token"
private let ownerTokenKeychainAccount = "owner-token"

private let preferredLanguageKey = "preferredLanguage"
private let screenRecordingPromptLastShownKey = "screenRecordingPromptLastShownAt"
private let desktopLanguageCodes = [
    "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt-BR", "it",
    "nl", "pl", "ru", "tr", "vi", "id", "th", "ar", "hi", "uk"
]
private let desktopLanguageOptions = [
    LanguageOption(code: "auto", name: "Auto (System)"),
    LanguageOption(code: "en", name: "English"),
    LanguageOption(code: "ko", name: "한국어"),
    LanguageOption(code: "ja", name: "日本語"),
    LanguageOption(code: "zh-Hans", name: "简体中文"),
    LanguageOption(code: "zh-Hant", name: "繁體中文"),
    LanguageOption(code: "es", name: "Español"),
    LanguageOption(code: "fr", name: "Français"),
    LanguageOption(code: "de", name: "Deutsch"),
    LanguageOption(code: "pt-BR", name: "Português (Brasil)"),
    LanguageOption(code: "it", name: "Italiano"),
    LanguageOption(code: "nl", name: "Nederlands"),
    LanguageOption(code: "pl", name: "Polski"),
    LanguageOption(code: "ru", name: "Русский"),
    LanguageOption(code: "tr", name: "Türkçe"),
    LanguageOption(code: "vi", name: "Tiếng Việt"),
    LanguageOption(code: "id", name: "Bahasa Indonesia"),
    LanguageOption(code: "th", name: "ไทย"),
    LanguageOption(code: "ar", name: "العربية"),
    LanguageOption(code: "hi", name: "हिन्दी"),
    LanguageOption(code: "uk", name: "Українська")
]

private let desktopLocalizationRows: [String: [String]] = [
    "defaultWorkspace": ["Default workspace", "기본 작업공간", "デフォルトワークスペース", "默认工作区", "預設工作區", "Espacio predeterminado", "Espace par défaut", "Standardarbeitsbereich", "Espaço padrão", "Area predefinita", "Standaardwerkruimte", "Domyślny obszar roboczy", "Рабочая область по умолчанию", "Varsayılan çalışma alanı", "Không gian mặc định", "Ruang kerja default", "พื้นที่ทำงานเริ่มต้น", "مساحة العمل الافتراضية", "डिफ़ॉल्ट कार्यक्षेत्र", "Типова робоча область"],
    "statusChecking": ["checking...", "확인 중...", "確認中...", "正在检查...", "正在檢查...", "comprobando...", "vérification...", "wird geprüft...", "verificando...", "controllo...", "controleren...", "sprawdzanie...", "проверка...", "kontrol ediliyor...", "đang kiểm tra...", "memeriksa...", "กำลังตรวจสอบ...", "جار التحقق...", "जांच हो रही है...", "перевірка..."],
    "statusOn": ["on", "켜짐", "オン", "开启", "開啟", "activo", "actif", "ein", "ligado", "attivo", "aan", "włączone", "вкл", "açık", "bật", "aktif", "เปิด", "تشغيل", "चालू", "увімкнено"],
    "statusOff": ["off", "꺼짐", "オフ", "关闭", "關閉", "inactivo", "inactif", "aus", "desligado", "spento", "uit", "wyłączone", "выкл", "kapalı", "tắt", "nonaktif", "ปิด", "إيقاف", "बंद", "вимкнено"],
    "statusStarting": ["starting...", "시작 중...", "起動中...", "正在启动...", "正在啟動...", "iniciando...", "démarrage...", "startet...", "iniciando...", "avvio...", "starten...", "uruchamianie...", "запуск...", "başlatılıyor...", "đang khởi động...", "memulai...", "กำลังเริ่ม...", "جار البدء...", "शुरू हो रहा है...", "запуск..."],
    "statusRestarting": ["restarting...", "재시작 중...", "再起動中...", "正在重启...", "正在重新啟動...", "reiniciando...", "redémarrage...", "Neustart...", "reiniciando...", "riavvio...", "opnieuw starten...", "restartowanie...", "перезапуск...", "yeniden başlatılıyor...", "đang khởi động lại...", "memulai ulang...", "กำลังรีสตาร์ท...", "جار إعادة التشغيل...", "फिर शुरू हो रहा है...", "перезапуск..."],
    "projectPrefix": ["Project", "프로젝트", "プロジェクト", "项目", "專案", "Proyecto", "Projet", "Projekt", "Projeto", "Progetto", "Project", "Projekt", "Проект", "Proje", "Dự án", "Proyek", "โปรเจกต์", "المشروع", "प्रोजेक्ट", "Проєкт"],
    "portPrefix": ["Port", "포트", "ポート", "端口", "連接埠", "Puerto", "Port", "Port", "Porta", "Porta", "Poort", "Port", "Порт", "Bağlantı noktası", "Cổng", "Port", "พอร์ต", "المنفذ", "पोर्ट", "Порт"],
    "startMCP": ["Start MCP", "MCP 시작", "MCP を開始", "启动 MCP", "啟動 MCP", "Iniciar MCP", "Démarrer MCP", "MCP starten", "Iniciar MCP", "Avvia MCP", "MCP starten", "Uruchom MCP", "Запустить MCP", "MCP başlat", "Khởi động MCP", "Mulai MCP", "เริ่ม MCP", "بدء MCP", "MCP शुरू करें", "Запустити MCP"],
    "stopMCP": ["Stop MCP", "MCP 중지", "MCP を停止", "停止 MCP", "停止 MCP", "Detener MCP", "Arrêter MCP", "MCP stoppen", "Parar MCP", "Ferma MCP", "MCP stoppen", "Zatrzymaj MCP", "Остановить MCP", "MCP durdur", "Dừng MCP", "Hentikan MCP", "หยุด MCP", "إيقاف MCP", "MCP रोकें", "Зупинити MCP"],
    "restartMCP": ["Restart MCP", "MCP 재시작", "MCP を再起動", "重启 MCP", "重新啟動 MCP", "Reiniciar MCP", "Redémarrer MCP", "MCP neu starten", "Reiniciar MCP", "Riavvia MCP", "MCP herstarten", "Uruchom ponownie MCP", "Перезапустить MCP", "MCP yeniden başlat", "Khởi động lại MCP", "Mulai ulang MCP", "รีสตาร์ท MCP", "إعادة تشغيل MCP", "MCP फिर शुरू करें", "Перезапустити MCP"],
    "restartAfterSaveTitle": ["Restart MCP now?", "지금 MCP를 재시작할까요?"],
    "restartAfterSaveInfo": ["Settings were saved, but the running MCP server keeps using the previous workspace, tunnel, port, and related options until it restarts.", "설정은 저장됐지만 실행 중인 MCP 서버는 재시작 전까지 이전 프로젝트 폴더, 터널, 포트 설정을 계속 사용합니다."],
    "selectProjectFolderMenu": ["Select Project Folder...", "프로젝트 폴더 선택...", "プロジェクトフォルダを選択...", "选择项目文件夹...", "選擇專案資料夾...", "Seleccionar carpeta del proyecto...", "Choisir le dossier du projet...", "Projektordner auswählen...", "Selecionar pasta do projeto...", "Seleziona cartella progetto...", "Projectmap kiezen...", "Wybierz folder projektu...", "Выбрать папку проекта...", "Proje klasörü seç...", "Chọn thư mục dự án...", "Pilih folder proyek...", "เลือกโฟลเดอร์โปรเจกต์...", "اختيار مجلد المشروع...", "प्रोजेक्ट फ़ोल्डर चुनें...", "Вибрати теку проєкту..."],
    "settingsMenu": ["Settings...", "설정...", "設定...", "设置...", "設定...", "Ajustes...", "Réglages...", "Einstellungen...", "Configurações...", "Impostazioni...", "Instellingen...", "Ustawienia...", "Настройки...", "Ayarlar...", "Cài đặt...", "Pengaturan...", "การตั้งค่า...", "الإعدادات...", "सेटिंग्स...", "Налаштування..."],
    "launchAtLoginMenu": ["Launch at Login", "로그인 시 실행", "ログイン時に起動", "登录时启动", "登入時啟動", "Iniciar al acceder", "Lancer à la connexion", "Beim Anmelden starten", "Abrir ao iniciar sessão", "Avvia al login", "Start bij inloggen", "Uruchamiaj przy logowaniu", "Запускать при входе", "Girişte başlat", "Mở khi đăng nhập", "Jalankan saat login", "เปิดเมื่อเข้าสู่ระบบ", "التشغيل عند تسجيل الدخول", "लॉगिन पर शुरू करें", "Запускати під час входу"],
    "startOnOpenMenu": ["Start MCP When App Opens", "앱 열 때 MCP 시작", "アプリ起動時に MCP を開始", "应用打开时启动 MCP", "App 開啟時啟動 MCP", "Iniciar MCP al abrir la app", "Démarrer MCP à l'ouverture", "MCP beim Öffnen starten", "Iniciar MCP ao abrir o app", "Avvia MCP all'apertura", "Start MCP bij openen", "Uruchamiaj MCP przy otwarciu", "Запускать MCP при открытии", "Uygulama açılınca MCP başlat", "Khởi động MCP khi mở ứng dụng", "Mulai MCP saat app dibuka", "เริ่ม MCP เมื่อเปิดแอป", "بدء MCP عند فتح التطبيق", "ऐप खुलने पर MCP शुरू करें", "Запускати MCP під час відкриття"],
    "ownerTokenRequiredTitle": ["Owner Token required", "오너 토큰이 필요합니다"],
    "ownerTokenRequiredInfo": ["MCP cannot start until an Owner Token exists. In the Settings window that opens next, click \"Generate Owner Token\", keep the copied value somewhere safe, then click Start MCP again.", "오너 토큰이 없으면 MCP를 시작할 수 없습니다. 이어서 열리는 설정 창에서 \"오너 토큰 생성\"을 누르고 복사된 값을 안전한 곳에 보관한 뒤, 다시 Start MCP를 누르세요."],
    "screenshotPermissionMenu": ["Screenshot Permission...", "스크린샷 권한..."],
    "screenshotPermissionTitle": ["Screen Recording permission", "화면 기록 권한"],
    "screenshotPermissionMissingInfo": ["ChatGPT To Codex needs macOS Screen Recording permission to capture E2E screenshots and show them inline in ChatGPT. Enable ChatGPT To Codex in System Settings > Privacy & Security > Screen Recording, then restart the app if macOS asks for it.", "E2E 스크린샷을 찍고 ChatGPT 답변에 인라인으로 보여주려면 macOS 화면 기록 권한이 필요합니다. 시스템 설정 > 개인정보 보호 및 보안 > 화면 기록에서 ChatGPT To Codex를 허용하고, macOS가 요청하면 앱을 재시작하세요."],
    "screenshotPermissionReadyInfo": ["Screen Recording permission is already allowed. E2E screenshots can be captured and returned inline.", "화면 기록 권한이 이미 허용되어 있습니다. E2E 스크린샷을 캡처해 인라인으로 제공할 수 있습니다."],
    "openPrivacySettings": ["Open Privacy Settings", "개인정보 설정 열기"],
    "requestPermission": ["Request Permission", "권한 요청"],
    "accessibilityPermissionMenu": ["Accessibility Permission...", "손쉬운 사용 권한..."],
    "accessibilityPermissionTitle": ["Accessibility permission", "손쉬운 사용 권한"],
    "accessibilityPermissionMissingInfo": ["ChatGPT To Codex needs macOS Accessibility permission to perform approved desktop-control clicks, typing, and key presses. Enable ChatGPT To Codex in System Settings > Privacy & Security > Accessibility, then restart the app if macOS asks for it.", "승인된 데스크톱 제어 클릭·입력·키 입력을 실행하려면 macOS 손쉬운 사용 권한이 필요합니다. 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 ChatGPT To Codex를 허용하고, macOS가 요청하면 앱을 재시작하세요."],
    "accessibilityPermissionReadyInfo": ["Accessibility permission is already allowed. Approved control actions can be executed.", "손쉬운 사용 권한이 이미 허용되어 있습니다. 승인된 제어 작업을 실행할 수 있습니다."],
    "pendingControlActionsMenu": ["Pending control actions", "대기 중인 제어 작업"],
    "controlNoPendingActions": ["No pending actions", "대기 중인 작업 없음"],
    "controlApprove": ["Approve", "승인"],
    "controlReject": ["Reject", "거부"],
    "agentArmStatusMenu": ["Agent Arm: local approval required", "Agent Arm: 로컬 승인 필요"],
    "agentArmStatusDetail": ["Remote ChatGPT can request control actions, but execution still requires this Mac's control lease, allowlist, sensitive-app checks, and kill switch.", "원격 ChatGPT는 제어 작업을 요청할 수 있지만 실행에는 이 Mac의 제어 lease, 허용 목록, 민감 앱 검사, kill switch가 계속 필요합니다."],
    "killControlMenu": ["Kill Control", "제어 강제 종료"],
    "killControlConfirmTitle": ["Kill control session?", "제어 세션을 강제 종료할까요?"],
    "killControlConfirmInfo": ["This immediately rejects every pending control action and blocks new ones until a fresh control lease is granted.", "대기 중인 모든 제어 작업을 즉시 거부하고, 새 제어 lease를 부여하기 전까지 새 작업을 차단합니다."],
    "approveAllControlMenu": ["Approve all pending", "대기 중인 작업 모두 승인"],
    "autoApproveOnMenu": ["Turn on auto-approve (10 min)", "자동 승인 켜기 (10분)"],
    "autoApproveOffMenu": ["Turn off auto-approve", "자동 승인 끄기"],
    "autoApproveStatusMenu": ["Auto-approve: on", "자동 승인: 켜짐"],
    "autoApproveUnavailableMenu": ["Auto-approve needs an allowlisted app (CHATGPT2CODEX_CONTROL_ALLOWLIST)", "자동 승인을 사용하려면 허용 목록(CHATGPT2CODEX_CONTROL_ALLOWLIST) 앱이 필요합니다"],
    "autoUpdatesMenu": ["Auto Check for Updates", "업데이트 자동 확인", "更新を自動確認", "自动检查更新", "自動檢查更新", "Buscar actualizaciones automáticamente", "Recherche auto des mises à jour", "Automatisch nach Updates suchen", "Verificar atualizações automaticamente", "Controlla aggiornamenti automaticamente", "Automatisch updates zoeken", "Automatycznie sprawdzaj aktualizacje", "Автопроверка обновлений", "Güncellemeleri otomatik denetle", "Tự động kiểm tra cập nhật", "Periksa pembaruan otomatis", "ตรวจอัปเดตอัตโนมัติ", "التحقق التلقائي من التحديثات", "अपडेट अपने-आप जांचें", "Автоматично перевіряти оновлення"],
    "openLocalHealth": ["Open Local Health", "로컬 상태 열기", "ローカルヘルスを開く", "打开本地健康检查", "開啟本機健康檢查", "Abrir estado local", "Ouvrir l'état local", "Lokalen Status öffnen", "Abrir saúde local", "Apri stato locale", "Lokale status openen", "Otwórz status lokalny", "Открыть локальный статус", "Yerel durumu aç", "Mở trạng thái cục bộ", "Buka kesehatan lokal", "เปิดสถานะภายใน", "فتح حالة الجهاز", "स्थानीय हेल्थ खोलें", "Відкрити локальний стан"],
    "openPublicHealth": ["Open Public Health", "공개 상태 열기", "公開ヘルスを開く", "打开公开健康检查", "開啟公開健康檢查", "Abrir estado público", "Ouvrir l'état public", "Öffentlichen Status öffnen", "Abrir saúde pública", "Apri stato pubblico", "Publieke status openen", "Otwórz status publiczny", "Открыть публичный статус", "Genel durumu aç", "Mở trạng thái công khai", "Buka kesehatan publik", "เปิดสถานะสาธารณะ", "فتح الحالة العامة", "सार्वजनिक हेल्थ खोलें", "Відкрити публічний стан"],
    "copyConnector": ["Copy Connector URL", "커넥터 URL 복사", "コネクタ URL をコピー", "复制连接器 URL", "複製連接器 URL", "Copiar URL del conector", "Copier l'URL du connecteur", "Connector-URL kopieren", "Copiar URL do conector", "Copia URL connettore", "Connector-URL kopiëren", "Kopiuj URL konektora", "Копировать URL коннектора", "Bağlayıcı URL'sini kopyala", "Sao chép URL kết nối", "Salin URL konektor", "คัดลอก URL ตัวเชื่อมต่อ", "نسخ رابط الموصل", "कनेक्टर URL कॉपी करें", "Скопіювати URL конектора"],
    "openGithub": ["Open GitHub Repository", "GitHub 저장소 열기", "GitHub リポジトリを開く", "打开 GitHub 仓库", "開啟 GitHub 儲存庫", "Abrir repositorio GitHub", "Ouvrir le dépôt GitHub", "GitHub-Repository öffnen", "Abrir repositório GitHub", "Apri repository GitHub", "GitHub-repository openen", "Otwórz repozytorium GitHub", "Открыть репозиторий GitHub", "GitHub deposunu aç", "Mở kho GitHub", "Buka repositori GitHub", "เปิด GitHub repository", "فتح مستودع GitHub", "GitHub रिपॉज़िटरी खोलें", "Відкрити репозиторій GitHub"],
    "checkUpdates": ["Check for Updates...", "업데이트 확인...", "更新を確認...", "检查更新...", "檢查更新...", "Buscar actualizaciones...", "Rechercher les mises à jour...", "Nach Updates suchen...", "Verificar atualizações...", "Controlla aggiornamenti...", "Updates zoeken...", "Sprawdź aktualizacje...", "Проверить обновления...", "Güncellemeleri denetle...", "Kiểm tra cập nhật...", "Periksa pembaruan...", "ตรวจหาอัปเดต...", "التحقق من التحديثات...", "अपडेट जांचें...", "Перевірити оновлення..."],
    "showLogs": ["Show Logs", "로그 보기", "ログを表示", "显示日志", "顯示日誌", "Mostrar registros", "Afficher les journaux", "Logs anzeigen", "Mostrar logs", "Mostra log", "Logs tonen", "Pokaż logi", "Показать журналы", "Günlükleri göster", "Hiện nhật ký", "Tampilkan log", "แสดงบันทึก", "عرض السجلات", "लॉग दिखाएं", "Показати журнали"],
    "runDoctor": ["Run Doctor", "Doctor 실행", "Doctor を実行", "运行 Doctor", "執行 Doctor", "Ejecutar Doctor", "Lancer Doctor", "Doctor ausführen", "Executar Doctor", "Esegui Doctor", "Doctor uitvoeren", "Uruchom Doctor", "Запустить Doctor", "Doctor çalıştır", "Chạy Doctor", "Jalankan Doctor", "เรียกใช้ Doctor", "تشغيل Doctor", "Doctor चलाएं", "Запустити Doctor"],
    "doctorTitle": ["ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor", "ChatGPT To Codex Doctor"],
    "doctorRunning": ["Running dependency doctor...", "의존성 Doctor 실행 중...", "依存関係 Doctor を実行中...", "正在运行依赖 Doctor...", "正在執行相依性 Doctor...", "Ejecutando Doctor de dependencias...", "Diagnostic des dépendances en cours...", "Abhängigkeits-Doctor läuft...", "Executando Doctor de dependências...", "Doctor dipendenze in esecuzione...", "Afhankelijkheidsdoctor uitvoeren...", "Uruchamianie doctora zależności...", "Запуск проверки зависимостей...", "Bağımlılık Doctor çalışıyor...", "Đang chạy Doctor phụ thuộc...", "Menjalankan Doctor dependensi...", "กำลังเรียกใช้ Doctor ตรวจ dependency...", "جار تشغيل Doctor للتبعيات...", "Dependency Doctor चल रहा है...", "Запуск Doctor залежностей..."],
    "ownerToken": ["Owner auth token", "소유자 인증 토큰"],
    "ownerTokenReady": ["configured", "설정됨"],
    "ownerTokenCopiedStatus": ["configured - copied", "설정됨 · 복사됨"],
    "ownerTokenMissing": ["not set", "미설정"],
    "ownerTokenGenerateCopy": ["Generate & Copy Token", "토큰 생성 후 복사"],
    "ownerTokenCopy": ["Copy Token", "토큰 복사"],
    "ownerTokenCopyUnavailable": ["Generate a token first. Existing tokens are stored by hash only unless this app generated them.", "먼저 토큰을 생성하세요. 기존 토큰은 이 앱이 생성한 경우가 아니면 해시로만 저장되어 다시 복사할 수 없습니다."],
    "ownerTokenGenerating": ["Generating...", "생성 중..."],
    "ownerTokenRegenerateTitle": ["Generate a new token?", "새 토큰을 생성할까요?"],
    "ownerTokenRegenerateInfo": ["The current token will be replaced and existing ChatGPT OAuth sessions will be revoked.", "현재 토큰이 새 토큰으로 교체되고 기존 ChatGPT OAuth 세션은 무효화됩니다."],
    "ownerTokenGeneratedTitle": ["Token copied", "토큰 복사됨"],
    "ownerTokenGeneratedInfo": ["A new owner auth token was generated, copied, and applied immediately. No settings save is needed. Store it in your password manager. Existing ChatGPT OAuth sessions were revoked.", "새 소유자 인증 토큰을 생성해 클립보드에 복사했고 즉시 적용했습니다. 설정 저장은 필요 없습니다. 비밀번호 관리자에 저장하세요. 기존 ChatGPT OAuth 세션은 무효화됐습니다."],
    "openStatus": ["Open Status", "상태 열기"],
    "about": ["About ezBuilder", "ezBuilder 정보", "ezBuilder について", "关于 ezBuilder", "關於 ezBuilder", "Acerca de ezBuilder", "À propos d'ezBuilder", "Über ezBuilder", "Sobre ezBuilder", "Informazioni su ezBuilder", "Over ezBuilder", "O ezBuilder", "О ezBuilder", "ezBuilder hakkında", "Giới thiệu ezBuilder", "Tentang ezBuilder", "حول ezBuilder", "ezBuilder के बारे में", "Про ezBuilder"],
    "quit": ["Quit", "종료", "終了", "退出", "結束", "Salir", "Quitter", "Beenden", "Sair", "Esci", "Afsluiten", "Zakończ", "Выход", "Çık", "Thoát", "Keluar", "ออก", "إنهاء", "बंद करें", "Вийти"],
    "tooltipState": ["ChatGPT To Codex MCP is %@", "ChatGPT To Codex MCP: %@", "ChatGPT To Codex MCP は %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP está %@", "ChatGPT To Codex MCP est %@", "ChatGPT To Codex MCP ist %@", "ChatGPT To Codex MCP está %@", "ChatGPT To Codex MCP è %@", "ChatGPT To Codex MCP is %@", "ChatGPT To Codex MCP jest %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP đang %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@", "ChatGPT To Codex MCP %@"] ,
    "selectProjectFolderTitle": ["Select Project Folder", "프로젝트 폴더 선택", "プロジェクトフォルダを選択", "选择项目文件夹", "選擇專案資料夾", "Seleccionar carpeta del proyecto", "Choisir le dossier du projet", "Projektordner auswählen", "Selecionar pasta do projeto", "Seleziona cartella progetto", "Projectmap kiezen", "Wybierz folder projektu", "Выбрать папку проекта", "Proje klasörü seç", "Chọn thư mục dự án", "Pilih folder proyek", "เลือกโฟลเดอร์โปรเจกต์", "اختيار مجلد المشروع", "प्रोजेक्ट फ़ोल्डर चुनें", "Вибрати теку проєкту"],
    "select": ["Select", "선택", "選択", "选择", "選擇", "Seleccionar", "Choisir", "Auswählen", "Selecionar", "Seleziona", "Kiezen", "Wybierz", "Выбрать", "Seç", "Chọn", "Pilih", "เลือก", "اختيار", "चुनें", "Вибрати"],
    "projectMarkerTitle": ["Project marker not found", "프로젝트 표시를 찾지 못했습니다", "プロジェクトマーカーが見つかりません", "未找到项目标记", "找不到專案標記", "No se encontró marcador de proyecto", "Marqueur de projet introuvable", "Projektmarker nicht gefunden", "Marcador do projeto não encontrado", "Marcatore progetto non trovato", "Projectmarkering niet gevonden", "Nie znaleziono znacznika projektu", "Маркер проекта не найден", "Proje işareti bulunamadı", "Không tìm thấy dấu hiệu dự án", "Penanda proyek tidak ditemukan", "ไม่พบตัวบ่งชี้โปรเจกต์", "لم يتم العثور على علامة مشروع", "प्रोजेक्ट संकेत नहीं मिला", "Маркер проєкту не знайдено"],
    "projectMarkerInfo": ["Choose a folder with .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt, or .chatgpt2codex.", ".git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt, .chatgpt2codex 중 하나가 있는 폴더를 선택하세요.", ".git、package.json、pubspec.yaml、go.mod、Cargo.toml、requirements.txt、.chatgpt2codex のいずれかがあるフォルダを選んでください。", "请选择包含 .git、package.json、pubspec.yaml、go.mod、Cargo.toml、requirements.txt 或 .chatgpt2codex 的文件夹。", "請選擇包含 .git、package.json、pubspec.yaml、go.mod、Cargo.toml、requirements.txt 或 .chatgpt2codex 的資料夾。", "Elige una carpeta con .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt o .chatgpt2codex.", "Choisissez un dossier avec .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt ou .chatgpt2codex.", "Wähle einen Ordner mit .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt oder .chatgpt2codex.", "Escolha uma pasta com .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt ou .chatgpt2codex.", "Scegli una cartella con .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt o .chatgpt2codex.", "Kies een map met .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt of .chatgpt2codex.", "Wybierz folder z .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt lub .chatgpt2codex.", "Выберите папку с .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt или .chatgpt2codex.", ".git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt veya .chatgpt2codex içeren bir klasör seçin.", "Chọn thư mục có .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt hoặc .chatgpt2codex.", "Pilih folder yang berisi .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt, atau .chatgpt2codex.", "เลือกโฟลเดอร์ที่มี .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt หรือ .chatgpt2codex", "اختر مجلدا يحتوي على .git أو package.json أو pubspec.yaml أو go.mod أو Cargo.toml أو requirements.txt أو .chatgpt2codex.", ".git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt या .chatgpt2codex वाला फ़ोल्डर चुनें।", "Виберіть теку з .git, package.json, pubspec.yaml, go.mod, Cargo.toml, requirements.txt або .chatgpt2codex."],
    "settingsTitle": ["ChatGPT To Codex Settings", "ChatGPT To Codex 설정", "ChatGPT To Codex 設定", "ChatGPT To Codex 设置", "ChatGPT To Codex 設定", "Ajustes de ChatGPT To Codex", "Réglages de ChatGPT To Codex", "ChatGPT To Codex Einstellungen", "Configurações do ChatGPT To Codex", "Impostazioni ChatGPT To Codex", "ChatGPT To Codex instellingen", "Ustawienia ChatGPT To Codex", "Настройки ChatGPT To Codex", "ChatGPT To Codex ayarları", "Cài đặt ChatGPT To Codex", "Pengaturan ChatGPT To Codex", "การตั้งค่า ChatGPT To Codex", "إعدادات ChatGPT To Codex", "ChatGPT To Codex सेटिंग्स", "Налаштування ChatGPT To Codex"],
    "settingsInfo": ["ezBuilder local MCP runtime settings", "ezBuilder 로컬 MCP 런타임 설정", "ezBuilder ローカル MCP ランタイム設定", "ezBuilder 本地 MCP 运行时设置", "ezBuilder 本機 MCP 執行階段設定", "Ajustes del runtime MCP local de ezBuilder", "Réglages du runtime MCP local ezBuilder", "Lokale MCP-Laufzeit von ezBuilder", "Configurações do runtime MCP local ezBuilder", "Impostazioni runtime MCP locale ezBuilder", "Lokale MCP-runtime instellingen van ezBuilder", "Ustawienia lokalnego runtime MCP ezBuilder", "Настройки локального MCP ezBuilder", "ezBuilder yerel MCP çalışma zamanı ayarları", "Cài đặt runtime MCP cục bộ ezBuilder", "Pengaturan runtime MCP lokal ezBuilder", "การตั้งค่ารันไทม์ MCP ภายในของ ezBuilder", "إعدادات تشغيل MCP المحلي من ezBuilder", "ezBuilder स्थानीय MCP रनटाइम सेटिंग्स", "Налаштування локального MCP runtime ezBuilder"],
    "language": ["Language", "언어", "言語", "语言", "語言", "Idioma", "Langue", "Sprache", "Idioma", "Lingua", "Taal", "Język", "Язык", "Dil", "Ngôn ngữ", "Bahasa", "ภาษา", "اللغة", "भाषा", "Мова"],
    "projectFolder": ["Project folder", "프로젝트 폴더", "プロジェクトフォルダ", "项目文件夹", "專案資料夾", "Carpeta del proyecto", "Dossier du projet", "Projektordner", "Pasta do projeto", "Cartella progetto", "Projectmap", "Folder projektu", "Папка проекта", "Proje klasörü", "Thư mục dự án", "Folder proyek", "โฟลเดอร์โปรเจกต์", "مجلد المشروع", "प्रोजेक्ट फ़ोल्डर", "Тека проєкту"],
    "browse": ["Browse...", "찾아보기...", "参照...", "浏览...", "瀏覽...", "Examinar...", "Parcourir...", "Durchsuchen...", "Procurar...", "Sfoglia...", "Bladeren...", "Przeglądaj...", "Обзор...", "Gözat...", "Duyệt...", "Telusuri...", "เรียกดู...", "استعراض...", "ब्राउज़...", "Огляд..."],
    "launchAtLoginSetting": ["Launch app at login", "로그인 시 앱 실행", "ログイン時にアプリを起動", "登录时启动应用", "登入時啟動 App", "Iniciar la app al acceder", "Lancer l'app à la connexion", "App beim Anmelden starten", "Abrir app ao iniciar sessão", "Avvia app al login", "App starten bij inloggen", "Uruchamiaj aplikację przy logowaniu", "Запускать приложение при входе", "Girişte uygulamayı başlat", "Mở ứng dụng khi đăng nhập", "Jalankan app saat login", "เปิดแอปเมื่อเข้าสู่ระบบ", "تشغيل التطبيق عند تسجيل الدخول", "लॉगिन पर ऐप शुरू करें", "Запускати застосунок під час входу"],
    "startOnOpenSetting": ["Start MCP when the app opens", "앱 열 때 MCP 시작", "アプリ起動時に MCP を開始", "应用打开时启动 MCP", "App 開啟時啟動 MCP", "Iniciar MCP al abrir la app", "Démarrer MCP à l'ouverture", "MCP beim Öffnen der App starten", "Iniciar MCP ao abrir o app", "Avvia MCP all'apertura", "Start MCP bij openen", "Uruchamiaj MCP przy otwarciu aplikacji", "Запускать MCP при открытии приложения", "Uygulama açılınca MCP başlat", "Khởi động MCP khi mở ứng dụng", "Mulai MCP saat app dibuka", "เริ่ม MCP เมื่อเปิดแอป", "بدء MCP عند فتح التطبيق", "ऐप खुलने पर MCP शुरू करें", "Запускати MCP під час відкриття застосунку"],
    "autoUpdatesSetting": ["Auto check for updates", "업데이트 자동 확인", "更新を自動確認", "自动检查更新", "自動檢查更新", "Buscar actualizaciones automáticamente", "Recherche automatique des mises à jour", "Automatisch nach Updates suchen", "Verificar atualizações automaticamente", "Controlla aggiornamenti automaticamente", "Automatisch updates zoeken", "Automatycznie sprawdzaj aktualizacje", "Автоматически проверять обновления", "Güncellemeleri otomatik denetle", "Tự động kiểm tra cập nhật", "Periksa pembaruan otomatis", "ตรวจอัปเดตอัตโนมัติ", "التحقق التلقائي من التحديثات", "अपडेट अपने-आप जांचें", "Автоматично перевіряти оновлення"],
    "publicTunnelSetting": ["Enable ChatGPT web connector", "ChatGPT 웹 커넥터 사용", "ChatGPT Web コネクタを有効化", "启用 ChatGPT 网页连接器", "啟用 ChatGPT 網頁連接器", "Activar conector web de ChatGPT", "Activer le connecteur web ChatGPT", "ChatGPT-Web-Connector aktivieren", "Ativar conector web do ChatGPT", "Abilita connettore web ChatGPT", "ChatGPT-webconnector inschakelen", "Włącz konektor web ChatGPT", "Включить веб-коннектор ChatGPT", "ChatGPT web bağlayıcısını etkinleştir", "Bật trình kết nối web ChatGPT", "Aktifkan konektor web ChatGPT", "เปิดตัวเชื่อมต่อเว็บ ChatGPT", "تفعيل موصل ChatGPT على الويب", "ChatGPT वेब कनेक्टर चालू करें", "Увімкнути веб-конектор ChatGPT"],
    "publicHostname": ["Owned fixed domain (optional)", "본인 소유 고정 도메인 (선택)", "所有する固定ドメイン (任意)", "自有固定域名（可选）", "自有固定網域（選填）", "Dominio fijo propio (opcional)", "Domaine fixe personnel (facultatif)", "Eigene feste Domain (optional)", "Domínio fixo próprio (opcional)", "Dominio fisso personale (opzionale)", "Eigen vast domein (optioneel)", "Własna stała domena (opcjonalnie)", "Собственный постоянный домен (необязательно)", "Kendi sabit alan adınız (isteğe bağlı)", "Tên miền cố định của bạn (tùy chọn)", "Domain tetap milik Anda (opsional)", "โดเมนคงที่ของคุณ (ไม่บังคับ)", "نطاق ثابت تملكه (اختياري)", "अपना स्थिर डोमेन (वैकल्पिक)", "Власний сталий домен (необов'язково)"],
    "publicHostnameHint": ["Blank uses a temporary Quick Tunnel URL. It changes on restart, so reconnect ChatGPT. Enter your own Cloudflare Named Tunnel hostname for daily use.", "비워두면 임시 Quick Tunnel URL을 씁니다. 재시작하면 주소가 바뀌므로 ChatGPT를 다시 연결해야 합니다. 상시 사용은 본인 Cloudflare Named Tunnel 호스트명을 입력하세요.", "空欄なら一時 Quick Tunnel URL を使います。再起動で変わるため ChatGPT の再接続が必要です。常用は自分の Cloudflare Named Tunnel ホスト名を入力してください。", "留空会使用临时 Quick Tunnel URL。重启后会变化，需要重新连接 ChatGPT。日常使用请输入自己的 Cloudflare Named Tunnel 主机名。", "留空會使用臨時 Quick Tunnel URL。重新啟動後會變更，需重新連接 ChatGPT。日常使用請輸入自己的 Cloudflare Named Tunnel 主機名稱。", "En blanco usa una URL temporal de Quick Tunnel. Cambia al reiniciar; vuelve a conectar ChatGPT. Para uso diario escribe tu hostname de Cloudflare Named Tunnel.", "Vide, utilise une URL Quick Tunnel temporaire. Elle change au redémarrage; reconnectez ChatGPT. Pour l'usage quotidien, indiquez votre hôte Cloudflare Named Tunnel.", "Leer nutzt eine temporäre Quick-Tunnel-URL. Sie ändert sich beim Neustart; ChatGPT neu verbinden. Für Dauerbetrieb eigene Cloudflare-Named-Tunnel-Hostname eintragen.", "Em branco usa uma URL temporária Quick Tunnel. Ela muda ao reiniciar; reconecte o ChatGPT. Para uso diário, informe seu hostname Cloudflare Named Tunnel.", "Vuoto usa un URL Quick Tunnel temporaneo. Cambia al riavvio; riconnetti ChatGPT. Per l'uso quotidiano inserisci il tuo hostname Cloudflare Named Tunnel.", "Leeg gebruikt een tijdelijke Quick Tunnel-URL. Die wijzigt na herstart; verbind ChatGPT opnieuw. Voor dagelijks gebruik vul je je Cloudflare Named Tunnel-hostnaam in.", "Puste używa tymczasowego URL Quick Tunnel. Zmienia się po restarcie; połącz ChatGPT ponownie. Do codziennego użycia wpisz własny hostname Cloudflare Named Tunnel.", "Пусто — временный URL Quick Tunnel. Он меняется при перезапуске; подключите ChatGPT заново. Для постоянной работы укажите свой hostname Cloudflare Named Tunnel.", "Boşsa geçici Quick Tunnel URL kullanır. Yeniden başlatınca değişir; ChatGPT'yi yeniden bağlayın. Günlük kullanım için kendi Cloudflare Named Tunnel hostname'inizi girin.", "Để trống sẽ dùng URL Quick Tunnel tạm thời. URL đổi khi khởi động lại; hãy kết nối lại ChatGPT. Dùng hằng ngày thì nhập hostname Cloudflare Named Tunnel của bạn.", "Kosong memakai URL Quick Tunnel sementara. URL berubah saat restart; hubungkan ulang ChatGPT. Untuk harian, isi hostname Cloudflare Named Tunnel milik Anda.", "เว้นว่างเพื่อใช้ URL Quick Tunnel ชั่วคราว ซึ่งจะเปลี่ยนเมื่อรีสตาร์ต ต้องเชื่อมต่อ ChatGPT ใหม่ ใช้งานประจำให้ใส่ hostname Cloudflare Named Tunnel ของคุณ", "فارغ يعني استخدام رابط Quick Tunnel مؤقت. يتغير عند إعادة التشغيل؛ أعد ربط ChatGPT. للاستخدام اليومي أدخل اسم مضيف Cloudflare Named Tunnel الخاص بك.", "खाली रखने पर अस्थायी Quick Tunnel URL प्रयोग होगा। रीस्टार्ट पर बदलता है; ChatGPT फिर जोड़ें। रोज़ उपयोग के लिए अपना Cloudflare Named Tunnel hostname डालें।", "Порожньо — тимчасовий URL Quick Tunnel. Після перезапуску змінюється; підключіть ChatGPT знову. Для щоденного використання вкажіть свій hostname Cloudflare Named Tunnel."],
    "fixedDomainSetup": ["Setup...", "설정..."],
    "fixedDomainSetupTitle": ["Fixed domain setup", "고정 주소 설정"],
    "fixedDomainSetupInfo": ["1. Put your domain on Cloudflare DNS.\n2. In Cloudflare Zero Trust, create a Tunnel public hostname for this Mac.\n3. Route that hostname to http://127.0.0.1:%@.\n4. Enter the hostname here, save, restart MCP, then register https://%@/mcp in ChatGPT.\n\nIf you do not own a domain yet, leave this blank and use the temporary web connector first.", "1. 개인 도메인을 Cloudflare DNS에 연결하세요.\n2. Cloudflare Zero Trust에서 이 Mac용 Tunnel public hostname을 만드세요.\n3. 해당 hostname을 http://127.0.0.1:%@ 로 연결하세요.\n4. 여기에 hostname을 입력하고 저장한 뒤 MCP를 재시작하고, ChatGPT에는 https://%@/mcp 를 등록하세요.\n\n아직 도메인이 없으면 비워두고 임시 웹 커넥터부터 쓰면 됩니다."],
    "openCloudflare": ["Open Cloudflare", "Cloudflare 열기"],
    "copyFixedDomainSteps": ["Copy Steps", "단계 복사"],
    "fixedDomainStepsCopied": ["Fixed domain setup steps copied.", "고정 주소 설정 단계를 복사했습니다."],
    "localPort": ["Local port", "로컬 포트", "ローカルポート", "本地端口", "本機連接埠", "Puerto local", "Port local", "Lokaler Port", "Porta local", "Porta locale", "Lokale poort", "Port lokalny", "Локальный порт", "Yerel bağlantı noktası", "Cổng cục bộ", "Port lokal", "พอร์ตภายใน", "المنفذ المحلي", "स्थानीय पोर्ट", "Локальний порт"],
    "githubRepositoryURL": ["GitHub repository URL", "GitHub 저장소 URL", "GitHub リポジトリ URL", "GitHub 仓库 URL", "GitHub 儲存庫 URL", "URL del repositorio GitHub", "URL du dépôt GitHub", "GitHub-Repository-URL", "URL do repositório GitHub", "URL repository GitHub", "GitHub-repository-URL", "URL repozytorium GitHub", "URL репозитория GitHub", "GitHub depo URL'si", "URL kho GitHub", "URL repositori GitHub", "URL GitHub repository", "رابط مستودع GitHub", "GitHub रिपॉज़िटरी URL", "URL репозиторію GitHub"],
    "save": ["Save", "저장", "保存", "保存", "儲存", "Guardar", "Enregistrer", "Speichern", "Salvar", "Salva", "Opslaan", "Zapisz", "Сохранить", "Kaydet", "Lưu", "Simpan", "บันทึก", "حفظ", "सहेजें", "Зберегти"],
    "cancel": ["Cancel", "취소", "キャンセル", "取消", "取消", "Cancelar", "Annuler", "Abbrechen", "Cancelar", "Annulla", "Annuleren", "Anuluj", "Отмена", "İptal", "Hủy", "Batal", "ยกเลิก", "إلغاء", "रद्द करें", "Скасувати"],
    "ok": ["OK", "확인", "OK", "确定", "確定", "Aceptar", "OK", "OK", "OK", "OK", "OK", "OK", "OK", "Tamam", "OK", "OK", "ตกลง", "موافق", "ठीक है", "OK"],
    "close": ["Close", "닫기", "閉じる", "关闭", "關閉", "Cerrar", "Fermer", "Schließen", "Fechar", "Chiudi", "Sluiten", "Zamknij", "Закрыть", "Kapat", "Đóng", "Tutup", "ปิด", "إغلاق", "बंद करें", "Закрити"],
    "updatesTitle": ["ChatGPT To Codex Updates", "ChatGPT To Codex 업데이트", "ChatGPT To Codex 更新", "ChatGPT To Codex 更新", "ChatGPT To Codex 更新", "Actualizaciones de ChatGPT To Codex", "Mises à jour ChatGPT To Codex", "ChatGPT To Codex Updates", "Atualizações do ChatGPT To Codex", "Aggiornamenti ChatGPT To Codex", "ChatGPT To Codex updates", "Aktualizacje ChatGPT To Codex", "Обновления ChatGPT To Codex", "ChatGPT To Codex güncellemeleri", "Cập nhật ChatGPT To Codex", "Pembaruan ChatGPT To Codex", "อัปเดต ChatGPT To Codex", "تحديثات ChatGPT To Codex", "ChatGPT To Codex अपडेट", "Оновлення ChatGPT To Codex"],
    "openReleases": ["Open Releases", "릴리즈 열기", "リリースを開く", "打开发布页", "開啟發行頁", "Abrir releases", "Ouvrir les versions", "Releases öffnen", "Abrir releases", "Apri release", "Releases openen", "Otwórz wydania", "Открыть релизы", "Sürümleri aç", "Mở bản phát hành", "Buka rilis", "เปิด releases", "فتح الإصدارات", "रिलीज़ खोलें", "Відкрити релізи"],
    "openGithubButton": ["Open GitHub", "GitHub 열기", "GitHub を開く", "打开 GitHub", "開啟 GitHub", "Abrir GitHub", "Ouvrir GitHub", "GitHub öffnen", "Abrir GitHub", "Apri GitHub", "GitHub openen", "Otwórz GitHub", "Открыть GitHub", "GitHub'u aç", "Mở GitHub", "Buka GitHub", "เปิด GitHub", "فتح GitHub", "GitHub खोलें", "Відкрити GitHub"],
    "aboutTitle": ["ChatGPT To Codex by ezBuilder", "ezBuilder의 ChatGPT To Codex", "ezBuilder による ChatGPT To Codex", "ezBuilder 出品 ChatGPT To Codex", "ezBuilder 製作 ChatGPT To Codex", "ChatGPT To Codex de ezBuilder", "ChatGPT To Codex par ezBuilder", "ChatGPT To Codex von ezBuilder", "ChatGPT To Codex por ezBuilder", "ChatGPT To Codex di ezBuilder", "ChatGPT To Codex door ezBuilder", "ChatGPT To Codex od ezBuilder", "ChatGPT To Codex от ezBuilder", "ezBuilder tarafından ChatGPT To Codex", "ChatGPT To Codex bởi ezBuilder", "ChatGPT To Codex oleh ezBuilder", "ChatGPT To Codex โดย ezBuilder", "ChatGPT To Codex من ezBuilder", "ezBuilder द्वारा ChatGPT To Codex", "ChatGPT To Codex від ezBuilder"],
    "aboutInfo": ["Copyright 2026 ezBuilder. All rights reserved.\nLocal MCP runtime for ChatGPT, Codex-compatible agents, and trusted local projects.", "Copyright 2026 ezBuilder. All rights reserved.\nChatGPT, Codex 호환 에이전트, 신뢰한 로컬 프로젝트를 위한 로컬 MCP 런타임입니다.", "Copyright 2026 ezBuilder. All rights reserved.\nChatGPT、Codex 互換エージェント、信頼済みローカルプロジェクト向けのローカル MCP ランタイムです。", "Copyright 2026 ezBuilder. All rights reserved.\n面向 ChatGPT、Codex 兼容代理和受信任本地项目的本地 MCP 运行时。", "Copyright 2026 ezBuilder. All rights reserved.\n供 ChatGPT、Codex 相容代理與受信任本機專案使用的本機 MCP 執行階段。", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP local para ChatGPT, agentes compatibles con Codex y proyectos locales de confianza.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP local pour ChatGPT, agents compatibles Codex et projets locaux fiables.", "Copyright 2026 ezBuilder. All rights reserved.\nLokale MCP-Laufzeit für ChatGPT, Codex-kompatible Agents und vertrauenswürdige lokale Projekte.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP local para ChatGPT, agentes compatíveis com Codex e projetos locais confiáveis.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP locale per ChatGPT, agent compatibili con Codex e progetti locali attendibili.", "Copyright 2026 ezBuilder. All rights reserved.\nLokale MCP-runtime voor ChatGPT, Codex-compatibele agents en vertrouwde lokale projecten.", "Copyright 2026 ezBuilder. All rights reserved.\nLokalny runtime MCP dla ChatGPT, agentów zgodnych z Codex i zaufanych projektów lokalnych.", "Copyright 2026 ezBuilder. All rights reserved.\nЛокальная среда MCP для ChatGPT, Codex-совместимых агентов и доверенных локальных проектов.", "Copyright 2026 ezBuilder. All rights reserved.\nChatGPT, Codex uyumlu ajanlar ve güvenilir yerel projeler için yerel MCP çalışma zamanı.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP cục bộ cho ChatGPT, tác nhân tương thích Codex và dự án cục bộ tin cậy.", "Copyright 2026 ezBuilder. All rights reserved.\nRuntime MCP lokal untuk ChatGPT, agen kompatibel Codex, dan proyek lokal tepercaya.", "Copyright 2026 ezBuilder. All rights reserved.\nรันไทม์ MCP ภายในสำหรับ ChatGPT, เอเจนต์ที่เข้ากันได้กับ Codex และโปรเจกต์ภายในที่เชื่อถือได้", "Copyright 2026 ezBuilder. All rights reserved.\nتشغيل MCP المحلي لـ ChatGPT والوكلاء المتوافقين مع Codex والمشاريع المحلية الموثوقة.", "Copyright 2026 ezBuilder. All rights reserved.\nChatGPT, Codex-संगत एजेंट और भरोसेमंद स्थानीय प्रोजेक्ट के लिए स्थानीय MCP रनटाइम।", "Copyright 2026 ezBuilder. All rights reserved.\nЛокальний runtime MCP для ChatGPT, Codex-сумісних агентів і довірених локальних проєктів."],
    "updatePageReady": ["Update page is ready.", "업데이트 페이지를 열 수 있습니다.", "更新ページを開けます。", "更新页面已准备好。", "更新頁面已就緒。", "La página de actualizaciones está lista.", "La page des mises à jour est prête.", "Die Update-Seite ist bereit.", "A página de atualizações está pronta.", "La pagina aggiornamenti è pronta.", "De updatepagina is klaar.", "Strona aktualizacji jest gotowa.", "Страница обновлений готова.", "Güncelleme sayfası hazır.", "Trang cập nhật đã sẵn sàng.", "Halaman pembaruan siap.", "หน้าการอัปเดตพร้อมแล้ว", "صفحة التحديث جاهزة.", "अपडेट पेज तैयार है।", "Сторінка оновлень готова."],
    "updateCheckFailed": ["Could not check releases automatically. Open the releases page instead.", "릴리즈를 자동 확인하지 못했습니다. 릴리즈 페이지를 여세요.", "リリースを自動確認できませんでした。リリースページを開いてください。", "无法自动检查发布。请打开发布页面。", "無法自動檢查發行版。請開啟發行頁。", "No se pudieron comprobar releases automáticamente. Abre la página de releases.", "Impossible de vérifier les versions automatiquement. Ouvrez la page des versions.", "Releases konnten nicht automatisch geprüft werden. Öffne die Releases-Seite.", "Não foi possível verificar releases automaticamente. Abra a página de releases.", "Impossibile controllare le release automaticamente. Apri la pagina release.", "Kan releases niet automatisch controleren. Open de releases-pagina.", "Nie można automatycznie sprawdzić wydań. Otwórz stronę wydań.", "Не удалось автоматически проверить релизы. Откройте страницу релизов.", "Sürümler otomatik denetlenemedi. Sürümler sayfasını açın.", "Không thể tự động kiểm tra bản phát hành. Hãy mở trang phát hành.", "Tidak dapat memeriksa rilis otomatis. Buka halaman rilis.", "ตรวจสอบ releases อัตโนมัติไม่ได้ ให้เปิดหน้า releases", "تعذر التحقق من الإصدارات تلقائيا. افتح صفحة الإصدارات.", "रिलीज़ अपने-आप नहीं जांच सके। रिलीज़ पेज खोलें।", "Не вдалося автоматично перевірити релізи. Відкрийте сторінку релізів."],
    "upToDate": ["ChatGPT To Codex is up to date (%@).", "ChatGPT To Codex가 최신입니다 (%@).", "ChatGPT To Codex は最新です (%@)。", "ChatGPT To Codex 已是最新版本（%@）。", "ChatGPT To Codex 已是最新版本（%@）。", "ChatGPT To Codex está actualizado (%@).", "ChatGPT To Codex est à jour (%@).", "ChatGPT To Codex ist aktuell (%@).", "ChatGPT To Codex está atualizado (%@).", "ChatGPT To Codex è aggiornato (%@).", "ChatGPT To Codex is up-to-date (%@).", "ChatGPT To Codex jest aktualny (%@).", "ChatGPT To Codex обновлен (%@).", "ChatGPT To Codex güncel (%@).", "ChatGPT To Codex đã mới nhất (%@).", "ChatGPT To Codex sudah terbaru (%@).", "ChatGPT To Codex เป็นเวอร์ชันล่าสุด (%@)", "ChatGPT To Codex محدث (%@).", "ChatGPT To Codex अप टू डेट है (%@)।", "ChatGPT To Codex оновлено (%@)."],
    "updateAvailable": ["Update available: %@. Installed: %@.", "업데이트 가능: %@. 설치됨: %@.", "更新があります: %@。インストール済み: %@。", "有可用更新：%@。已安装：%@。", "有可用更新：%@。已安裝：%@。", "Actualización disponible: %@. Instalado: %@.", "Mise à jour disponible : %@. Installé : %@.", "Update verfügbar: %@. Installiert: %@.", "Atualização disponível: %@. Instalado: %@.", "Aggiornamento disponibile: %@. Installato: %@.", "Update beschikbaar: %@. Geïnstalleerd: %@.", "Dostępna aktualizacja: %@. Zainstalowano: %@.", "Доступно обновление: %@. Установлено: %@.", "Güncelleme var: %@. Kurulu: %@.", "Có bản cập nhật: %@. Đã cài: %@.", "Pembaruan tersedia: %@. Terpasang: %@.", "มีอัปเดต: %@ ติดตั้งอยู่: %@", "يتوفر تحديث: %@. المثبت: %@.", "अपडेट उपलब्ध: %@. इंस्टॉल: %@.", "Доступне оновлення: %@. Встановлено: %@."]
]

private func resolveDesktopLanguage(_ configured: String?) -> String {
    let raw = configured == nil || configured == "auto" ? (Locale.preferredLanguages.first ?? "en") : configured!
    let lower = raw.lowercased()
    if lower.hasPrefix("zh-hant") || lower.hasPrefix("zh-tw") || lower.hasPrefix("zh-hk") || lower.hasPrefix("zh-mo") {
        return "zh-Hant"
    }
    if lower.hasPrefix("zh") {
        return "zh-Hans"
    }
    if lower.hasPrefix("pt") {
        return "pt-BR"
    }
    for code in desktopLanguageCodes {
        let exact = code.lowercased()
        let prefix = exact.split(separator: "-").first.map(String.init) ?? exact
        if lower == exact || lower.hasPrefix(prefix + "-") {
            return code
        }
    }
    return "en"
}

private func localizedText(_ key: String, language: String) -> String {
    guard let row = desktopLocalizationRows[key],
          let index = desktopLanguageCodes.firstIndex(of: language),
          index < row.count,
          !row[index].isEmpty
    else {
        return desktopLocalizationRows[key]?.first ?? key
    }
    let value = row[index]
    return key == "checkUpdates" ? value.replacingOccurrences(of: "...", with: "").replacingOccurrences(of: "…", with: "") : value
}

private final class ServiceController {
    private let environment = ProcessInfo.processInfo.environment
    private let defaults = UserDefaults.standard
    private let selectedProjectFolderKey = "selectedProjectFolder"
    private let publicHostnameKey = "publicHostname"
    private let cloudflaredTunnelNameKey = "cloudflaredTunnelName"
    private let enablePublicTunnelKey = "enablePublicTunnel"
    private let portKey = "port"
    private let launchAtLoginKey = "launchAtLogin"
    private let startMCPOnLaunchKey = "startMCPOnLaunch"
    private let autoCheckUpdatesKey = "autoCheckUpdates"
    private(set) var process: Process?

    let appName = "ChatGPT To Codex"
    let defaultWorkspace: String
    let runtimeRoot: URL
    let logFile: URL

    var appVersion: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        return short?.isEmpty == false ? short! : (build?.isEmpty == false ? build! : "0.0.0")
    }

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        defaultWorkspace = environment["CHATGPT2CODEX_WORKSPACE"] ?? "\(home)/workspace"

        if let resourceRoot = Bundle.main.resourceURL?.appendingPathComponent("chatgpt2codex"),
           FileManager.default.fileExists(atPath: resourceRoot.appendingPathComponent("start-chatgpt.sh").path) {
            runtimeRoot = resourceRoot
        } else {
            runtimeRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        }

        let logDir = URL(fileURLWithPath: home)
            .appendingPathComponent("Library")
            .appendingPathComponent("Logs")
            .appendingPathComponent(appName)
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        logFile = logDir.appendingPathComponent("chatgpt2codex.log")
    }

    var port: Int {
        if let envPort = environment["CHATGPT2CODEX_PORT"], let value = Int(envPort) {
            return value
        }
        let saved = defaults.integer(forKey: portKey)
        return saved > 0 ? saved : 7979
    }

    var publicHost: String? {
        let configuredHost = environment["CHATGPT2CODEX_PUBLIC_HOSTNAME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        if configuredHost?.isEmpty == false {
            return configuredHost
        }
        guard enablePublicTunnel else { return nil }
        return savedPublicHost
    }

    var savedPublicHost: String? {
        let savedHost = defaults.string(forKey: publicHostnameKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return savedHost?.isEmpty == false ? savedHost : nil
    }

    var cloudflaredTunnelName: String? {
        let configured = environment["CLOUDFLARED_TUNNEL_NAME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        if configured?.isEmpty == false {
            return configured
        }
        let saved = defaults.string(forKey: cloudflaredTunnelNameKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return saved?.isEmpty == false ? saved : nil
    }

    var enablePublicTunnel: Bool {
        if environment["CHATGPT2CODEX_EXPOSE_WEB"] == "1" { return true }
        if environment["CHATGPT2CODEX_PUBLIC_HOSTNAME"]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return true
        }
        return defaults.bool(forKey: enablePublicTunnelKey)
    }

    var launchAtLogin: Bool {
        defaults.bool(forKey: launchAtLoginKey)
    }

    var startMCPOnLaunch: Bool {
        defaults.bool(forKey: startMCPOnLaunchKey)
    }

    var autoCheckUpdates: Bool {
        defaults.bool(forKey: autoCheckUpdatesKey)
    }

    var githubRepoURL: URL {
        let configured = environment["CHATGPT2CODEX_UPDATE_REPO_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        return URL(string: configured?.isEmpty == false ? configured! : "https://github.com/ezBuilder/chatgpt2codex")!
    }

    var preferredLanguage: String {
        defaults.string(forKey: preferredLanguageKey) ?? "auto"
    }

    var effectiveLanguageCode: String {
        resolveDesktopLanguage(preferredLanguage)
    }

    func localized(_ key: String) -> String {
        localizedText(key, language: effectiveLanguageCode)
    }

    var screenRecordingAllowed: Bool {
        if #available(macOS 10.15, *) {
            return CGPreflightScreenCaptureAccess()
        }
        return true
    }

    func shouldPromptForScreenRecordingPermission() -> Bool {
        if screenRecordingAllowed { return false }
        let lastShown = defaults.double(forKey: screenRecordingPromptLastShownKey)
        return lastShown == 0 || Date().timeIntervalSince1970 - lastShown > 86_400
    }

    func markScreenRecordingPromptShown() {
        defaults.set(Date().timeIntervalSince1970, forKey: screenRecordingPromptLastShownKey)
    }

    func requestScreenRecordingPermission() -> Bool {
        if #available(macOS 10.15, *) {
            return CGRequestScreenCaptureAccess()
        }
        return true
    }

    func openScreenRecordingSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    /// Whether Option B desktop control is enabled at all, mirroring
    /// src/control/policy.ts isControlEnabled(). Enabled by default (even
    /// with no environment configured, e.g. launched via `open`); set
    /// CHATGPT2CODEX_CONTROL to "0"/"false"/"off" (case-insensitive) to opt
    /// out. This environment is also what launchServer()/runDoctor() forward
    /// to the managed `chatgpt2codex serve` subprocess, so this check tracks
    /// exactly what the subprocess itself would see.
    var controlEnabled: Bool {
        guard let raw = environment["CHATGPT2CODEX_CONTROL"] else { return true }
        let normalized = raw.trimmingCharacters(in: .whitespaces).lowercased()
        return normalized != "0" && normalized != "false" && normalized != "off"
    }

    var accessibilityTrusted: Bool {
        AXIsProcessTrusted()
    }

    /// Prompts the user via the system Accessibility-permission dialog
    /// (kAXTrustedCheckOptionPrompt). Returns the trust state at call time.
    @discardableResult
    func requestAccessibilityPermission() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    func openAccessibilitySettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    struct PendingControlAction {
        let actionId: String
        let appName: String
        let kind: String
        let targetSummary: String
        /// Human-readable dry-run AX resolve preview (src/control/queue.ts
        /// ResolvedTargetPreview), or nil when the target has no `ax` field.
        /// Always safe to display: never contains the raw `text` payload.
        let resolvedSummary: String?
    }

    private func summarizeControlTarget(_ target: [String: Any]?) -> String {
        guard let target else { return "" }
        if let ax = target["ax"] as? [String: Any] {
            let role = ax["role"] as? String ?? "element"
            if let label = (ax["title"] as? String) ?? (ax["label"] as? String), !label.isEmpty {
                return "\(role) \"\(label)\""
            }
            return role
        }
        if let point = target["windowPoint"] as? [String: Any],
           let xRel = point["xRel"] as? Double, let yRel = point["yRel"] as? Double {
            return String(format: "point (%.2f, %.2f)", xRel, yRel)
        }
        return ""
    }

    /// Renders the read-only AX resolve preview (src/control/queue.ts
    /// ResolvedTargetPreview / src/control/mac-input.ts resolveAxElement) as
    /// a human sentence for the approval UI, e.g. "Will act on button
    /// \"Send\" at (120, 340, 80, 24) in Slack/Message a channel, 1 match" or
    /// "No accessibility match found (empty/opt-out AX tree) - expect a
    /// windowPoint fallback" when resolve failed.
    private func summarizeResolvedPreview(_ resolved: [String: Any]?) -> String? {
        guard let resolved else { return nil }
        let found = resolved["found"] as? Bool ?? false
        guard found else {
            let reason = resolved["reason"] as? String ?? "not found"
            return "No accessibility match found (\(reason)) — expect a windowPoint fallback"
        }
        let role = resolved["role"] as? String ?? "element"
        let label = (resolved["title"] as? String) ?? (resolved["description"] as? String)
        var target = label.map { "\(role) \"\($0)\"" } ?? role
        if let frame = resolved["frame"] as? [String: Any],
           let x = frame["x"] as? Double, let y = frame["y"] as? Double,
           let w = frame["width"] as? Double, let h = frame["height"] as? Double {
            target += String(format: " at (%.0f, %.0f, %.0f, %.0f)", x, y, w, h)
        }
        var location = ""
        if let app = resolved["app"] as? String { location = app }
        if let window = resolved["window"] as? String, !window.isEmpty {
            location = location.isEmpty ? window : "\(location)/\(window)"
        }
        if !location.isEmpty { target += " in \(location)" }
        if let matchCount = resolved["matchCount"] as? Int {
            target += ", \(matchCount) match\(matchCount == 1 ? "" : "es")"
        }
        return "Will act on \(target)"
    }

    /// `chatgpt2codex control list`, filtered to actions still awaiting local
    /// human approval. See src/control/queue.ts listActions/toSummary.
    func listPendingControlActions() -> [PendingControlAction] {
        guard let result = try? runCli(["control", "list"]), result.status == 0,
              let data = result.stdout.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else {
            return []
        }
        return array.compactMap { entry in
            guard entry["status"] as? String == "pending", let actionId = entry["actionId"] as? String else {
                return nil
            }
            return PendingControlAction(
                actionId: actionId,
                appName: entry["appName"] as? String ?? "",
                kind: entry["kind"] as? String ?? "",
                targetSummary: summarizeControlTarget(entry["target"] as? [String: Any]),
                resolvedSummary: summarizeResolvedPreview(entry["resolved"] as? [String: Any])
            )
        }
    }

    /// `chatgpt2codex control approve <actionId>`.
    @discardableResult
    func approveControlAction(_ actionId: String) -> Bool {
        (try? runCli(["control", "approve", actionId]))?.status == 0
    }

    /// `chatgpt2codex control reject <actionId>`.
    @discardableResult
    func rejectControlAction(_ actionId: String) -> Bool {
        (try? runCli(["control", "reject", actionId]))?.status == 0
    }

    /// `chatgpt2codex control kill`: rejects every pending action and blocks
    /// new ones until a fresh control lease is granted.
    @discardableResult
    func killControl() -> Bool {
        (try? runCli(["control", "kill"]))?.status == 0
    }

    /// `chatgpt2codex control approve-all`: local-human batch-approve of
    /// every currently pending action. The CLI itself re-skips any
    /// sensitive-app/non-allowlisted target and stops on a kill, so this is
    /// never a way to approve something a single `control approve` couldn't.
    @discardableResult
    func approveAllControlActions() -> Bool {
        (try? runCli(["control", "approve-all"]))?.status == 0
    }

    /// The same `CHATGPT2CODEX_CONTROL_ALLOWLIST` the managed subprocess
    /// sees (src/control/policy.ts controlAllowlist), read here only to
    /// supply `--apps` for the status-bar auto-approve toggle below — this
    /// never widens the scope beyond what the operator already allowlisted.
    var controlAllowlistApps: [String] {
        (environment["CHATGPT2CODEX_CONTROL_ALLOWLIST"] ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// `chatgpt2codex control auto status`.
    func autoApproveStatus() -> (enabled: Bool, remainingMs: Int) {
        guard let result = try? runCli(["control", "auto", "status"]), result.status == 0,
              let data = result.stdout.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return (false, 0)
        }
        return (obj["autoEnabled"] as? Bool ?? false, obj["remainingMs"] as? Int ?? 0)
    }

    /// `chatgpt2codex control auto on --apps <allowlist>`. Local-human-only
    /// entrypoint: this status-bar toggle never writes the AUTO scope file
    /// itself, it only shells out to the same CLI a terminal user would run.
    /// Scope is always the live control allowlist, so toggling this can
    /// never reach an app the operator hasn't already explicitly allowed.
    @discardableResult
    func enableAutoApprove() -> Bool {
        let apps = controlAllowlistApps
        guard !apps.isEmpty else { return false }
        return (try? runCli(["control", "auto", "on", "--apps", apps.joined(separator: ",")]))?.status == 0
    }

    /// `chatgpt2codex control auto off`.
    @discardableResult
    func disableAutoApprove() -> Bool {
        (try? runCli(["control", "auto", "off"]))?.status == 0
    }

    private var cliScript: URL {
        runtimeRoot.appendingPathComponent("dist").appendingPathComponent("cli.js")
    }

    private func runCli(_ arguments: [String], stdin: String? = nil) throws -> (status: Int32, stdout: String, stderr: String) {
        let bundledNode = runtimeRoot.appendingPathComponent("bin").appendingPathComponent("node")
        let useBundledNode = FileManager.default.fileExists(atPath: bundledNode.path)
        let process = Process()
        process.executableURL = useBundledNode ? bundledNode : URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = useBundledNode ? [cliScript.path] + arguments : ["node", cliScript.path] + arguments

        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "\(runtimeRoot.appendingPathComponent("bin").path):\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\(environment["PATH"] ?? "")"
        process.environment = environment

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        var stdinPipe: Pipe?
        if stdin != nil {
            let pipe = Pipe()
            stdinPipe = pipe
            process.standardInput = pipe
        }

        try process.run()
        if let stdin, let data = stdin.data(using: .utf8), let pipe = stdinPipe {
            pipe.fileHandleForWriting.write(data)
            try? pipe.fileHandleForWriting.close()
        }
        process.waitUntilExit()

        let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, stdout, stderr)
    }

    func ownerTokenConfigured() -> Bool {
        guard let result = try? runCli(["owner-token", "--status", "--workspace", workspace]),
              result.status == 0,
              let data = result.stdout.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return false
        }
        return json["configured"] as? Bool == true
    }

    func generateOwnerToken() throws -> String {
        let result = try runCli(["owner-token", "--generate", "--workspace", workspace])
        guard result.status == 0,
              let data = result.stdout.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["ownerToken"] as? String,
              !token.isEmpty
        else {
            throw NSError(domain: "ChatGPTToCodex", code: 2, userInfo: [
                NSLocalizedDescriptionKey: result.stderr.isEmpty ? "Owner token generation failed." : result.stderr
            ])
        }
        return token
    }

    func setOwnerToken(_ token: String) throws {
        let result = try runCli(["owner-token", "--set-stdin", "--workspace", workspace], stdin: token)
        if result.status != 0 {
            throw NSError(domain: "ChatGPTToCodex", code: 3, userInfo: [
                NSLocalizedDescriptionKey: result.stderr.isEmpty ? "Owner token update failed." : result.stderr
            ])
        }
    }

    var releasesURL: URL {
        githubRepoURL.appendingPathComponent("releases")
    }

    var selectedProjectFolder: URL? {
        guard let value = defaults.string(forKey: selectedProjectFolderKey), !value.isEmpty else {
            return nil
        }
        return URL(fileURLWithPath: value)
    }

    var workspace: String {
        selectedProjectFolder?.path ?? defaultWorkspace
    }

    var activeProjectRoot: String? {
        guard let selectedProjectFolder, hasProjectMarker(selectedProjectFolder) else {
            return nil
        }
        return selectedProjectFolder.path
    }

    var projectDisplayName: String {
        selectedProjectFolder?.lastPathComponent ?? localized("defaultWorkspace")
    }

    func setSelectedProjectFolder(_ url: URL) {
        defaults.set(url.path, forKey: selectedProjectFolderKey)
    }

    func clearSelectedProjectFolder() {
        defaults.removeObject(forKey: selectedProjectFolderKey)
    }

    func setPublicHostname(_ value: String) {
        defaults.set(value.trimmingCharacters(in: .whitespacesAndNewlines), forKey: publicHostnameKey)
    }

    func setEnablePublicTunnel(_ enabled: Bool) {
        defaults.set(enabled, forKey: enablePublicTunnelKey)
    }

    func setPort(_ value: Int) {
        defaults.set(value, forKey: portKey)
    }

    func setStartMCPOnLaunch(_ enabled: Bool) {
        defaults.set(enabled, forKey: startMCPOnLaunchKey)
    }

    func setAutoCheckUpdates(_ enabled: Bool) {
        defaults.set(enabled, forKey: autoCheckUpdatesKey)
    }

    func setPreferredLanguage(_ value: String) {
        defaults.set(value, forKey: preferredLanguageKey)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        defaults.set(enabled, forKey: launchAtLoginKey)
        let appPath = Bundle.main.bundleURL.path
        let script: String
        if enabled {
            script = """
            tell application "System Events"
              if not (exists login item \(appleScriptString(appName))) then
                make login item at end with properties {name:\(appleScriptString(appName)), path:\(appleScriptString(appPath)), hidden:true}
              end if
            end tell
            """
        } else {
            script = """
            tell application "System Events"
              delete login items whose name is \(appleScriptString(appName))
            end tell
            """
        }
        runAppleScript(script)
    }

    func hasProjectMarker(_ url: URL) -> Bool {
        let markers = [".git", "package.json", "pubspec.yaml", "go.mod", "Cargo.toml", "requirements.txt", ".chatgpt2codex"]
        return markers.contains { marker in
            FileManager.default.fileExists(atPath: url.appendingPathComponent(marker).path)
        }
    }

    func ensureWorkspaceDirectory(_ url: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return true
        } catch {
            return false
        }
    }

    var healthURL: URL {
        URL(string: "http://127.0.0.1:\(port)/healthz")!
    }

    var publicBaseURL: URL? {
        guard enablePublicTunnel else { return nil }
        if let publicHost {
            return URL(string: "https://\(publicHost)")
        }
        return discoverQuickTunnelBaseURL()
    }

    var loopbackBaseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    /// The URL to register in an MCP client.
    ///
    /// This used to be nil whenever the public tunnel was off, which made
    /// "Copy Connector URL" a menu item that silently did nothing — the most
    /// confusing possible failure for someone trying to finish setup. In
    /// loopback mode the local `/mcp` URL is the correct thing to copy; only
    /// ChatGPT *web* needs the tunnel. So always return something copyable.
    var connectorURL: URL? {
        (publicBaseURL ?? loopbackBaseURL).appendingPathComponent("mcp")
    }

    /// True only when the connector URL is reachable from ChatGPT web, i.e.
    /// a public tunnel is actually up. Drives the "Open Public Health" item.
    var hasPublicConnectorURL: Bool {
        publicBaseURL != nil
    }

    var publicHealthURL: URL? {
        publicBaseURL?.appendingPathComponent("healthz")
    }

    var isManagedProcessRunning: Bool {
        if let process {
            return process.isRunning
        }
        return false
    }

    func checkHealth(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { data, response, error in
            let okStatus = (response as? HTTPURLResponse)?.statusCode == 200
            let okBody = data.flatMap { String(data: $0, encoding: .utf8) }?.contains("\"ok\":true") == true
            DispatchQueue.main.async {
                completion(error == nil && okStatus && okBody)
            }
        }.resume()
    }

    func start(completion: @escaping (Bool) -> Void) {
        checkHealth { [weak self] alreadyRunning in
            guard let self else { return }
            if alreadyRunning {
                completion(true)
                return
            }
            do {
                try self.launchServer()
                completion(true)
            } catch {
                self.appendLog("launch failed: \(error.localizedDescription)\n")
                completion(false)
            }
        }
    }

    func stop() {
        if let process, process.isRunning {
            process.terminate()
        }
        process = nil

        let startPattern = shellQuote("start-chatgpt.sh")
        let servePattern = shellQuote("dist/cli.js serve --http --port \(port)")
        let tunnelPattern = shellQuote("cloudflared.*127.0.0.1:\(port)|cloudflared.*localhost:\(port)")
        let command = """
        pkill -f \(startPattern) 2>/dev/null || true
        pkill -f \(servePattern) 2>/dev/null || true
        pkill -f \(tunnelPattern) 2>/dev/null || true
        """
        runDetachedShell(command)
    }

    func restart(completion: @escaping (Bool) -> Void) {
        stop()
        // Wait for the old server to actually release port `port` (up to 15s)
        // rather than assuming a flat 1s is enough. Starting too early is what
        // produced the EADDRINUSE crash the new server could not recover from.
        waitForPortRelease(deadline: Date().addingTimeInterval(15)) { [weak self] in
            self?.start(completion: completion)
        }
    }

    private func launchServer() throws {
        let script = runtimeRoot.appendingPathComponent("start-chatgpt.sh")
        guard FileManager.default.fileExists(atPath: script.path) else {
            throw NSError(domain: "ChatGPTToCodex", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "start-chatgpt.sh not found at \(script.path)"
            ])
        }

        // A tunnel name only means anything when the public tunnel is on. It
        // used to be exported unconditionally and never unset, so a name left
        // over in Settings kept forcing tunnel mode even with the toggle off —
        // and the launcher then aborted because no hostname was configured.
        // Every run now states both variables explicitly.
        let tunnelNameLine: String
        if enablePublicTunnel, let cloudflaredTunnelName {
            tunnelNameLine = "export CLOUDFLARED_TUNNEL_NAME=\(shellQuote(cloudflaredTunnelName))"
        } else {
            tunnelNameLine = "unset CLOUDFLARED_TUNNEL_NAME"
        }

        let command = """
        cd \(shellQuote(runtimeRoot.path))
        export PATH=\(shellQuote(runtimeRoot.appendingPathComponent("bin").path))":$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
        export WORKSPACE=\(shellQuote(workspace))
        export PORT=\(port)
        \(enablePublicTunnel ? "export CHATGPT2CODEX_EXPOSE_WEB=1" : "unset CHATGPT2CODEX_EXPOSE_WEB")
        \(publicHost.map { "export PUBLIC_HOSTNAME=\(shellQuote($0))" } ?? "unset PUBLIC_HOSTNAME")
        \(tunnelNameLine)
        \(activeProjectRoot.map { "export CHATGPT2CODEX_ACTIVE_PROJECT_ROOT=\(shellQuote($0))" } ?? "")
        exec /bin/bash \(shellQuote(script.path))
        """

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]

        if !FileManager.default.fileExists(atPath: logFile.path) {
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
        }
        // Everything already in the log belongs to earlier runs; record where
        // this run starts so a dead tunnel URL from a previous session can
        // never be handed back as the current connector URL.
        markLogScanFloor()
        let logHandle = try FileHandle(forWritingTo: logFile)
        try logHandle.seekToEnd()
        let pipe = Pipe()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            try? logHandle.write(contentsOf: data)
            if let text = String(data: data, encoding: .utf8) {
                self?.appendLogMirror(text)
            }
        }
        process.standardOutput = pipe
        process.standardError = pipe
        process.terminationHandler = { [weak self] _ in
            pipe.fileHandleForReading.readabilityHandler = nil
            try? logHandle.close()
            DispatchQueue.main.async {
                if self?.process === process {
                    self?.process = nil
                }
            }
        }
        try process.run()
        self.process = process
    }

    private func appendLog(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: logFile.path) {
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logFile) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.close()
        }
    }

    private func appendLogMirror(_ text: String) {
        if text.contains("chatgpt2codex is ready") || text.contains("exited") || text.contains("missing command") {
            NSLog("%@", text)
        }
    }

    /// Scrape the quick-tunnel URL out of the launcher's output.
    ///
    /// The log file is append-only and never truncated, so scanning the whole
    /// file returned the last URL *ever* seen — including one from a previous
    /// session whose tunnel is long dead. Copying that into ChatGPT produces
    /// exactly the "MCP connection failed" the user cannot explain, because
    /// the URL looks perfectly valid. Only bytes written since the current
    /// launch are considered, so a run that produced no tunnel reports no URL
    /// instead of resurrecting a stale one.
    private func discoverQuickTunnelBaseURL() -> URL? {
        guard let data = try? Data(contentsOf: logFile) else { return nil }
        let fresh = logScanFloor <= data.count ? data.subdata(in: logScanFloor..<data.count) : data
        guard let text = String(data: fresh, encoding: .utf8),
              let regex = try? NSRegularExpression(pattern: #"https://[A-Za-z0-9-]+\.trycloudflare\.com"#)
        else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.matches(in: text, range: range).last,
              let matchRange = Range(match.range, in: text)
        else {
            return nil
        }
        return URL(string: String(text[matchRange]))
    }

    /// Byte offset into `logFile` marking the start of the current launch.
    /// Everything before it belongs to earlier runs and must be ignored when
    /// discovering the live tunnel URL.
    private var logScanFloor = 0

    private func markLogScanFloor() {
        let attributes = try? FileManager.default.attributesOfItem(atPath: logFile.path)
        logScanFloor = (attributes?[.size] as? Int) ?? 0
    }

    /// Whether anything is currently listening on the loopback port.
    ///
    /// `stop()` only sends SIGTERM (via a detached pkill) and returns
    /// immediately, so the old server can still own the socket for a second
    /// or two. Starting the replacement before it lets go made the new
    /// process die on EADDRINUSE — the restart loop behind "Restart MCP never
    /// comes back". Poll instead of guessing with a fixed delay.
    private func portIsFree() -> Bool {
        guard let checkPort = UInt16(exactly: port) else { return true }
        let socketFD = socket(AF_INET, SOCK_STREAM, 0)
        guard socketFD >= 0 else { return true }
        defer { close(socketFD) }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = checkPort.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let connectResult = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.connect(socketFD, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        // connect() succeeding means something accepted us: the port is taken.
        return connectResult != 0
    }

    private func waitForPortRelease(deadline: Date, completion: @escaping () -> Void) {
        if portIsFree() || Date() >= deadline {
            completion()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.waitForPortRelease(deadline: deadline, completion: completion)
        }
    }

    func checkForUpdates(completion: @escaping (String, URL?) -> Void) {
        let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let apiPath = githubRepoURL.path
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .replacingOccurrences(of: ".git", with: "")
        guard let apiURL = URL(string: "https://api.github.com/repos/\(apiPath)/releases/latest") else {
            completion(localized("updatePageReady"), releasesURL)
            return
        }
        var request = URLRequest(url: apiURL)
        request.timeoutInterval = 5
        request.setValue("chatgpt2codex", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            let latest = data.flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            }.flatMap { json in
                (json["tag_name"] as? String) ?? (json["name"] as? String)
            }?.trimmingCharacters(in: CharacterSet(charactersIn: "vV "))
            DispatchQueue.main.async {
                guard status == 200, let latest, !latest.isEmpty else {
                    completion(self.localized("updateCheckFailed"), self.releasesURL)
                    return
                }
                if latest == currentVersion {
                    completion(String(format: self.localized("upToDate"), currentVersion), nil)
                } else {
                    completion(String(format: self.localized("updateAvailable"), latest, currentVersion), self.releasesURL)
                }
            }
        }.resume()
    }

    func runDoctor(repair: Bool = true) -> String {
        let direct = runtimeRoot.appendingPathComponent("macos-dependency-doctor.sh")
        let source = runtimeRoot.appendingPathComponent("scripts/macos-dependency-doctor.sh")
        let script = FileManager.default.fileExists(atPath: direct.path) ? direct : source
        guard FileManager.default.fileExists(atPath: script.path) else {
            return "Doctor script not found.\nExpected: \(direct.path)"
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = repair ? [script.path, "--repair"] : [script.path]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "\(runtimeRoot.appendingPathComponent("bin").path):\(runtimeRoot.appendingPathComponent("node/bin").path):\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\(environment["PATH"] ?? "")"
        environment["WORKSPACE"] = workspace
        environment["PORT"] = "\(port)"
        environment["CHATGPT2CODEX_DOCTOR_REPAIR"] = repair ? "1" : "0"
        if enablePublicTunnel {
            environment["CHATGPT2CODEX_EXPOSE_WEB"] = "1"
        } else {
            environment.removeValue(forKey: "CHATGPT2CODEX_EXPOSE_WEB")
        }
        if let publicHost {
            environment["PUBLIC_HOSTNAME"] = publicHost
        } else {
            environment.removeValue(forKey: "PUBLIC_HOSTNAME")
        }
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return "Doctor failed to start: \(error.localizedDescription)"
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        return output + "\nExit code: \(process.terminationStatus)"
    }

    private func runDetachedShell(_ command: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]
        try? process.run()
    }

    private func runAppleScript(_ script: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
    }
}

private final class StatusBarAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let controller = ServiceController()
    private var statusItem: NSStatusItem!
    private var statusMenuItem = NSMenuItem(title: "ChatGPT To Codex: checking...", action: nil, keyEquivalent: "")
    private var projectMenuItem = NSMenuItem()
    private var portMenuItem = NSMenuItem()
    private var toggleItem = NSMenuItem()
    private var restartItem = NSMenuItem()
    private var openPublicHealthItem = NSMenuItem()
    private var copyConnectorItem = NSMenuItem()
    private var pendingControlSubmenu: NSMenu?
    private var timer: Timer?
    private var killHotkeyGlobalMonitor: Any?
    private var killHotkeyLocalMonitor: Any?
    private var latestHealth = false
    private var settingsWindow: NSWindow?
    private var logWindow: NSWindow?
    private var doctorWindow: NSWindow?
    private weak var settingsLanguagePopup: NSPopUpButton?
    private weak var settingsProjectField: NSTextField?
    private weak var settingsLaunchAtLogin: NSButton?
    private weak var settingsStartOnLaunch: NSButton?
    private weak var settingsAutoUpdate: NSButton?
    private weak var settingsPublicTunnel: NSButton?
    private weak var settingsOwnerTokenStatus: NSTextField?
    private weak var settingsOwnerTokenButton: NSButton?
    private weak var settingsOwnerTokenCopyButton: NSButton?
    private var settingsOwnerTokenConfigured = false
    private weak var settingsHostField: NSTextField?
    private weak var settingsPortField: NSTextField?

    private func t(_ key: String) -> String {
        controller.localized(key)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            if let image = NSImage(named: "AppIcon") ?? NSImage(named: "StatusIconTemplate") {
                image.isTemplate = false
                image.size = NSSize(width: 22, height: 22)
                button.image = image
                button.imagePosition = .imageOnly
            }
            button.toolTip = "ChatGPT To Codex"
        }
        rebuildMenu()
        refreshStatus()
        registerGlobalKillHotkeyIfNeeded()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.promptScreenRecordingPermissionIfNeeded(force: false)
        }
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
        if controller.startMCPOnLaunch {
            if !controller.ownerTokenConfigured() {
                warnOwnerTokenMissing()
                showSettings()
                return
            }
            controller.start { [weak self] ok in
                guard let self else { return }
                self.refreshStatus()
                if !ok {
                    self.runDoctor()
                }
            }
        }
        if controller.autoCheckUpdates {
            controller.checkForUpdates { [weak self] message, _ in
                self?.statusMenuItem.title = message
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        if let monitor = killHotkeyGlobalMonitor { NSEvent.removeMonitor(monitor) }
        if let monitor = killHotkeyLocalMonitor { NSEvent.removeMonitor(monitor) }
        controller.stop()
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "ChatGPT To Codex: \(t("statusChecking"))", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        statusMenuItem.image = symbol("circle.dashed")
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())

        // Desktop-control (Option B) human-approval surface. Hidden entirely
        // when the feature flag is off, matching src/control/policy.ts
        // isControlEnabled(): doing nothing means these tools are never
        // reachable and this UI has nothing to show. The kill switch is
        // placed at the very top of the control section so it is reachable
        // in one click without hunting through a submenu.
        if controller.controlEnabled {
            let armItem = NSMenuItem(title: t("agentArmStatusMenu"), action: nil, keyEquivalent: "")
            armItem.isEnabled = false
            armItem.image = symbol("shield.lefthalf.filled")
            armItem.toolTip = t("agentArmStatusDetail")
            menu.addItem(armItem)

            let killItem = menuItem(t("killControlMenu"), #selector(killControlAction), "hand.raised.fill")
            menu.addItem(killItem)

            let pendingSubmenu = NSMenu()
            pendingSubmenu.delegate = self
            pendingControlSubmenu = pendingSubmenu
            let pendingItem = NSMenuItem(title: t("pendingControlActionsMenu"), action: nil, keyEquivalent: "")
            pendingItem.image = symbol("checklist")
            pendingItem.submenu = pendingSubmenu
            menu.addItem(pendingItem)
            menu.addItem(.separator())
        }

        toggleItem = NSMenuItem(title: t("startMCP"), action: #selector(toggleServer), keyEquivalent: "s")
        toggleItem.target = self
        toggleItem.image = symbol("play.circle")
        menu.addItem(toggleItem)

        restartItem = NSMenuItem(title: t("restartMCP"), action: #selector(restartServer), keyEquivalent: "r")
        restartItem.target = self
        restartItem.image = symbol("arrow.clockwise.circle")
        menu.addItem(restartItem)
        menu.addItem(menuItem(t("screenshotPermissionMenu"), #selector(showScreenRecordingPermission), "camera.viewfinder"))
        if controller.controlEnabled {
            menu.addItem(menuItem(t("accessibilityPermissionMenu"), #selector(showAccessibilityPermission), "figure.roll"))
        }
        menu.addItem(menuItem(t("settingsMenu"), #selector(showSettings), "gearshape"))
        menu.addItem(.separator())
        menu.addItem(menuItem(t("quit"), #selector(quit), "power"))
        statusItem.menu = menu
    }

    private func menuItem(_ title: String, _ action: Selector, _ symbolName: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.image = symbol(symbolName)
        return item
    }

    private func checkMenuItem(_ title: String, _ action: Selector, _ checked: Bool, _ symbolName: String) -> NSMenuItem {
        let item = menuItem(title, action, symbolName)
        item.state = checked ? .on : .off
        return item
    }

    private func symbol(_ name: String) -> NSImage? {
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) else {
            return nil
        }
        image.isTemplate = true
        return image
    }

    private func refreshStatus() {
        controller.checkHealth { [weak self] ok in
            guard let self else { return }
            self.latestHealth = ok
            let state = ok ? self.t("statusOn") : self.t("statusOff")
            self.statusMenuItem.title = "ChatGPT To Codex: \(state)"
            self.statusMenuItem.image = self.symbol(ok ? "checkmark.circle" : "xmark.circle")
            self.projectMenuItem.title = "\(self.t("projectPrefix")): \(self.controller.projectDisplayName)"
            self.portMenuItem.title = "\(self.t("portPrefix")): \(self.controller.port)"
            self.toggleItem.title = ok || self.controller.isManagedProcessRunning ? self.t("stopMCP") : self.t("startMCP")
            self.toggleItem.image = self.symbol(ok || self.controller.isManagedProcessRunning ? "stop.circle" : "play.circle")
            self.toggleItem.keyEquivalent = ok || self.controller.isManagedProcessRunning ? "x" : "s"
            self.restartItem.isEnabled = true
            // "Open Public Health" only makes sense behind a live tunnel, but
            // the connector URL is always copyable (loopback in local mode) —
            // these are no longer the same condition.
            self.openPublicHealthItem.isEnabled = self.controller.hasPublicConnectorURL
            self.copyConnectorItem.isEnabled = self.controller.connectorURL != nil
            self.statusItem.button?.toolTip = String(format: self.t("tooltipState"), state)
        }
    }

    /// Explain why the server cannot start yet, instead of bouncing the user
    /// back into Settings with no message.
    private func warnOwnerTokenMissing() {
        let alert = NSAlert()
        alert.messageText = t("ownerTokenRequiredTitle")
        alert.informativeText = t("ownerTokenRequiredInfo")
        alert.alertStyle = .warning
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func toggleServer() {
        if latestHealth || controller.isManagedProcessRunning {
            controller.stop()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.refreshStatus()
            }
        } else {
            if !controller.ownerTokenConfigured() {
                // Previously this silently reopened Settings, so "Start MCP"
                // looked like it did nothing but bounce you back into setup —
                // repeatedly, with no clue what was missing. Say what is
                // wrong before showing the window.
                warnOwnerTokenMissing()
                showSettings()
                return
            }
            statusMenuItem.title = "ChatGPT To Codex: \(t("statusStarting"))"
            controller.start { [weak self] ok in
                guard let self else { return }
                self.refreshStatus()
                if !ok {
                    self.runDoctor()
                }
            }
        }
    }

    @objc private func restartServer() {
        statusMenuItem.title = "ChatGPT To Codex: \(t("statusRestarting"))"
        controller.restart { [weak self] _ in
            self?.refreshStatus()
        }
    }

    private func confirmRestartAfterSettingsSave() -> Bool {
        let alert = NSAlert()
        alert.messageText = t("restartAfterSaveTitle")
        alert.informativeText = t("restartAfterSaveInfo")
        alert.alertStyle = .informational
        alert.addButton(withTitle: t("restartMCP"))
        alert.addButton(withTitle: t("cancel"))
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func restartAfterSavedSettingsIfConfirmed(_ shouldRestart: Bool) {
        guard shouldRestart else {
            refreshStatus()
            return
        }
        if confirmRestartAfterSettingsSave() {
            statusMenuItem.title = "ChatGPT To Codex: \(t("statusRestarting"))"
            controller.restart { [weak self] _ in self?.refreshStatus() }
        } else {
            refreshStatus()
        }
    }

    private func promptScreenRecordingPermissionIfNeeded(force: Bool) {
        if controller.screenRecordingAllowed {
            if force {
                let readyAlert = NSAlert()
                readyAlert.messageText = t("screenshotPermissionTitle")
                readyAlert.informativeText = t("screenshotPermissionReadyInfo")
                readyAlert.alertStyle = .informational
                readyAlert.addButton(withTitle: t("ok"))
                NSApp.activate(ignoringOtherApps: true)
                readyAlert.runModal()
            }
            return
        }
        guard force || controller.shouldPromptForScreenRecordingPermission() else { return }
        controller.markScreenRecordingPromptShown()

        let alert = NSAlert()
        alert.messageText = t("screenshotPermissionTitle")
        alert.informativeText = t("screenshotPermissionMissingInfo")
        alert.alertStyle = .warning
        alert.addButton(withTitle: t("openPrivacySettings"))
        alert.addButton(withTitle: t("requestPermission"))
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            controller.openScreenRecordingSettings()
        } else if response == .alertSecondButtonReturn {
            _ = controller.requestScreenRecordingPermission()
            if !controller.screenRecordingAllowed {
                controller.openScreenRecordingSettings()
            }
        }
    }

    @objc private func showScreenRecordingPermission() {
        promptScreenRecordingPermissionIfNeeded(force: true)
    }

    @objc private func showAccessibilityPermission() {
        if controller.accessibilityTrusted {
            let readyAlert = NSAlert()
            readyAlert.messageText = t("accessibilityPermissionTitle")
            readyAlert.informativeText = t("accessibilityPermissionReadyInfo")
            readyAlert.alertStyle = .informational
            readyAlert.addButton(withTitle: t("ok"))
            NSApp.activate(ignoringOtherApps: true)
            readyAlert.runModal()
            return
        }

        let alert = NSAlert()
        alert.messageText = t("accessibilityPermissionTitle")
        alert.informativeText = t("accessibilityPermissionMissingInfo")
        alert.alertStyle = .warning
        alert.addButton(withTitle: t("openPrivacySettings"))
        alert.addButton(withTitle: t("requestPermission"))
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            controller.openAccessibilitySettings()
        } else if response == .alertSecondButtonReturn {
            if !controller.requestAccessibilityPermission() {
                controller.openAccessibilitySettings()
            }
        }
    }

    /// NSMenuDelegate: rebuild the pending-control-actions submenu with the
    /// live queue state each time the user opens it, rather than on a timer,
    /// so approve/reject always act on current data.
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === pendingControlSubmenu else { return }
        menu.removeAllItems()

        // Auto-approve toggle: local-human-only (runCli(["control", "auto",
        // ...]) — see ServiceController.enableAutoApprove/disableAutoApprove
        // above). Shown disabled when the current control allowlist is empty
        // since there is nothing it could ever scope to.
        let autoStatus = controller.autoApproveStatus()
        let autoItem: NSMenuItem
        if autoStatus.enabled {
            let minutesLeft = max(1, autoStatus.remainingMs / 60000)
            autoItem = NSMenuItem(title: "\(t("autoApproveStatusMenu")) (\(minutesLeft)m) — \(t("autoApproveOffMenu"))", action: #selector(toggleAutoApprove), keyEquivalent: "")
        } else {
            autoItem = NSMenuItem(title: t("autoApproveOnMenu"), action: #selector(toggleAutoApprove), keyEquivalent: "")
        }
        autoItem.target = self
        autoItem.isEnabled = autoStatus.enabled || !controller.controlAllowlistApps.isEmpty
        if !autoStatus.enabled && controller.controlAllowlistApps.isEmpty {
            autoItem.toolTip = t("autoApproveUnavailableMenu")
        }
        menu.addItem(autoItem)
        menu.addItem(.separator())

        let pending = controller.listPendingControlActions()
        if pending.isEmpty {
            let empty = NSMenuItem(title: t("controlNoPendingActions"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }

        let approveAll = NSMenuItem(title: t("approveAllControlMenu"), action: #selector(approveAllPendingControlActions), keyEquivalent: "")
        approveAll.target = self
        menu.addItem(approveAll)
        menu.addItem(.separator())

        for action in pending {
            let summary = [action.appName, action.kind, action.targetSummary].filter { !$0.isEmpty }.joined(separator: " · ")
            let header = NSMenuItem(title: summary, action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)

            // Dry-run AX resolve preview, shown to the approver before
            // anything executes (see src/control/tools.ts
            // handleComputerRequestAction / summarizeResolvedPreview above).
            if let resolvedSummary = action.resolvedSummary {
                let preview = NSMenuItem(title: "  \(resolvedSummary)", action: nil, keyEquivalent: "")
                preview.isEnabled = false
                menu.addItem(preview)
            }

            let approve = NSMenuItem(title: "  \(t("controlApprove"))", action: #selector(approvePendingControlAction(_:)), keyEquivalent: "")
            approve.target = self
            approve.representedObject = action.actionId
            menu.addItem(approve)

            let reject = NSMenuItem(title: "  \(t("controlReject"))", action: #selector(rejectPendingControlAction(_:)), keyEquivalent: "")
            reject.target = self
            reject.representedObject = action.actionId
            menu.addItem(reject)

            menu.addItem(.separator())
        }
    }

    @objc private func approvePendingControlAction(_ sender: NSMenuItem) {
        guard let actionId = sender.representedObject as? String else { return }
        controller.approveControlAction(actionId)
    }

    @objc private func rejectPendingControlAction(_ sender: NSMenuItem) {
        guard let actionId = sender.representedObject as? String else { return }
        controller.rejectControlAction(actionId)
    }

    @objc private func approveAllPendingControlActions() {
        controller.approveAllControlActions()
    }

    /// Local-human-only auto-approve toggle: always shells out to
    /// `chatgpt2codex control auto on|off` (ServiceController above), never
    /// writes the AUTO scope file directly.
    @objc private func toggleAutoApprove() {
        if controller.autoApproveStatus().enabled {
            controller.disableAutoApprove()
        } else {
            controller.enableAutoApprove()
        }
    }

    /// Global emergency-stop hotkey (⌃⌥⌘.) for Option B desktop control:
    /// pressed anywhere on the system, it calls `chatgpt2codex control kill`
    /// immediately via the same runCli path as the menu item, with no
    /// confirmation dialog — unlike the menu's killControlAction, a
    /// deliberately pressed panic-button combo shouldn't need a second click
    /// to take effect. Registered only when control is enabled at all
    /// (isControlEnabled()); doing nothing when it's off means the hotkey is
    /// never even listened for, matching every other control gate.
    private func isKillHotkeyEvent(_ event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        // kVK_ANSI_Period = 47 on a US layout; deviceIndependentFlagsMask
        // keeps this keyCode-based match layout-agnostic for the modifiers.
        return mods == [.control, .option, .command] && event.keyCode == 47
    }

    private func registerGlobalKillHotkeyIfNeeded() {
        guard controller.controlEnabled else { return }
        killHotkeyGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.isKillHotkeyEvent(event) else { return }
            self.controller.killControl()
        }
        killHotkeyLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            if self.isKillHotkeyEvent(event) {
                self.controller.killControl()
                return nil
            }
            return event
        }
    }

    @objc private func killControlAction() {
        let alert = NSAlert()
        alert.messageText = t("killControlConfirmTitle")
        alert.informativeText = t("killControlConfirmInfo")
        alert.alertStyle = .warning
        alert.addButton(withTitle: t("killControlMenu"))
        alert.addButton(withTitle: t("cancel"))
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        controller.killControl()
    }

    @objc private func selectProjectFolder() {
        let panel = NSOpenPanel()
        panel.title = t("selectProjectFolderTitle")
        panel.prompt = t("select")
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = controller.selectedProjectFolder ?? URL(fileURLWithPath: controller.workspace)
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            _ = self.controller.ensureWorkspaceDirectory(url)
            let shouldRestart = self.latestHealth || self.controller.isManagedProcessRunning
            self.controller.setSelectedProjectFolder(url)
            self.rebuildMenu()
            self.restartAfterSavedSettingsIfConfirmed(shouldRestart)
        }
    }

    @objc private func showSettings() {
        settingsWindow?.close()
        let width: CGFloat = 540
        let hintWidth: CGFloat = 322
        let publicHintY: CGFloat = 398
        let hintFont = NSFont.systemFont(ofSize: 10)
        func measuredHintHeight(_ text: String, width: CGFloat) -> CGFloat {
            let rect = (text as NSString).boundingRect(
                with: NSSize(width: width, height: CGFloat.greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: hintFont]
            )
            return max(58, ceil(rect.height) + 8)
        }
        let publicHintText = t("publicHostnameHint")
        let publicHintHeight = measuredHintHeight(publicHintText, width: hintWidth)
        let localPortY = publicHintY + publicHintHeight + 18
        let portFieldY = localPortY - 4
        let actionRow1Y = localPortY + 44
        let actionRow2Y = actionRow1Y + 38
        let footerY = actionRow2Y + 54
        let footerButtonY = footerY - 6
        let height: CGFloat = max(690, footerButtonY + 76)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = t("settingsTitle")
        window.isReleasedWhenClosed = false
        let content = FlippedView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        window.contentView = content

        func label(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat = 12, bold: Bool = false) -> NSTextField {
            let field = NSTextField(labelWithString: text)
            field.frame = NSRect(x: x, y: y, width: width, height: 20)
            field.font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
            field.textColor = .secondaryLabelColor
            return field
        }

        func hint(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat) -> NSTextField {
            let field = NSTextField(wrappingLabelWithString: text)
            field.frame = NSRect(x: x, y: y, width: width, height: height)
            field.font = hintFont
            field.textColor = .secondaryLabelColor
            field.maximumNumberOfLines = 0
            field.cell?.wraps = true
            return field
        }

        func field(_ value: String, x: CGFloat, y: CGFloat, width: CGFloat, placeholder: String = "") -> NSTextField {
            let textField = NSTextField(string: value)
            textField.frame = NSRect(x: x, y: y, width: width, height: 28)
            textField.placeholderString = placeholder
            return textField
        }

        func button(_ title: String, x: CGFloat, y: CGFloat, width: CGFloat, action: Selector) -> NSButton {
            let item = NSButton(title: title, target: self, action: action)
            item.frame = NSRect(x: x, y: y, width: width, height: 30)
            item.bezelStyle = .rounded
            return item
        }

        let iconFile = Bundle.main.resourceURL?.appendingPathComponent("chatgpt2codex-icon.png")
        let settingsIcon = iconFile.flatMap { NSImage(contentsOf: $0) } ?? NSImage(named: "AppIcon") ?? NSImage(named: "StatusIconTemplate")
        if let image = settingsIcon {
            let imageView = NSImageView(frame: NSRect(x: (width - 82) / 2, y: 12, width: 82, height: 82))
            imageView.image = image
            imageView.imageScaling = .scaleProportionallyUpOrDown
            content.addSubview(imageView)
        }
        content.addSubview(label(t("language"), x: 28, y: 142, width: 170))
        let languagePopup = NSPopUpButton(frame: .zero, pullsDown: false)
        languagePopup.frame = NSRect(x: 190, y: 138, width: 220, height: 28)
        for option in desktopLanguageOptions {
            languagePopup.addItem(withTitle: option.name)
            languagePopup.lastItem?.representedObject = option.code
        }
        if let selected = languagePopup.itemArray.first(where: { ($0.representedObject as? String) == controller.preferredLanguage }) {
            languagePopup.select(selected)
        }
        languagePopup.target = self
        languagePopup.action = #selector(settingsLanguageChanged)
        settingsLanguagePopup = languagePopup
        content.addSubview(languagePopup)

        content.addSubview(label(t("projectFolder"), x: 28, y: 184, width: 170))
        let projectField = field(controller.selectedProjectFolder?.path ?? "", x: 190, y: 180, width: 230, placeholder: controller.defaultWorkspace)
        projectField.placeholderString = controller.defaultWorkspace
        projectField.isEditable = false
        projectField.isSelectable = true
        projectField.focusRingType = .none
        settingsProjectField = projectField
        content.addSubview(projectField)
        content.addSubview(button(t("browse"), x: 428, y: 179, width: 84, action: #selector(browseProjectFolderFromSettings)))

        let launchAtLogin = NSButton(checkboxWithTitle: t("launchAtLoginSetting"), target: nil, action: nil)
        launchAtLogin.frame = NSRect(x: 190, y: 220, width: 320, height: 22)
        launchAtLogin.state = controller.launchAtLogin ? .on : .off
        settingsLaunchAtLogin = launchAtLogin
        content.addSubview(launchAtLogin)
        let startOnLaunch = NSButton(checkboxWithTitle: t("startOnOpenSetting"), target: nil, action: nil)
        startOnLaunch.frame = NSRect(x: 190, y: 246, width: 320, height: 22)
        startOnLaunch.state = controller.startMCPOnLaunch ? .on : .off
        settingsStartOnLaunch = startOnLaunch
        content.addSubview(startOnLaunch)
        let tokenConfigured = controller.ownerTokenConfigured()
        settingsOwnerTokenConfigured = tokenConfigured
        content.addSubview(label(t("ownerToken"), x: 28, y: 272, width: 170))
        let tokenStatus = label(tokenConfigured ? t("ownerTokenReady") : t("ownerTokenMissing"), x: 190, y: 272, width: 170)
        tokenStatus.textColor = tokenConfigured ? .systemGreen : .systemOrange
        settingsOwnerTokenStatus = tokenStatus
        content.addSubview(tokenStatus)
        let tokenButton = button(t("ownerTokenGenerateCopy"), x: 190, y: 296, width: 210, action: #selector(generateAndCopyOwnerToken))
        settingsOwnerTokenButton = tokenButton
        content.addSubview(tokenButton)
        let tokenCopyButton = button(t("ownerTokenCopy"), x: 410, y: 296, width: 102, action: #selector(copyStoredOwnerToken))
        tokenCopyButton.isEnabled = loadOwnerTokenFromKeychain() != nil
        settingsOwnerTokenCopyButton = tokenCopyButton
        content.addSubview(tokenCopyButton)

        let publicTunnel = NSButton(checkboxWithTitle: t("publicTunnelSetting"), target: nil, action: nil)
        publicTunnel.frame = NSRect(x: 190, y: 334, width: 322, height: 22)
        publicTunnel.state = controller.enablePublicTunnel ? .on : .off
        settingsPublicTunnel = publicTunnel
        content.addSubview(publicTunnel)

        content.addSubview(label(t("publicHostname"), x: 28, y: 370, width: 170))
        let hostField = field(controller.savedPublicHost ?? "", x: 190, y: 366, width: 230, placeholder: "chatgpt2codex.example.com")
        settingsHostField = hostField
        content.addSubview(hostField)
        content.addSubview(button(t("fixedDomainSetup"), x: 428, y: 365, width: 84, action: #selector(showFixedDomainSetup)))
        content.addSubview(hint(publicHintText, x: 190, y: publicHintY, width: hintWidth, height: publicHintHeight))
        content.addSubview(label(t("localPort"), x: 28, y: localPortY, width: 170))
        let portField = field("\(controller.port)", x: 190, y: portFieldY, width: 120)
        settingsPortField = portField
        content.addSubview(portField)

        let actionColW: CGFloat = 235
        let actionCol2X: CGFloat = 277
        content.addSubview(button(t("copyConnector"), x: 28, y: actionRow1Y, width: actionColW, action: #selector(copyConnectorURL)))
        content.addSubview(button(t("openStatus"), x: actionCol2X, y: actionRow1Y, width: actionColW, action: #selector(openStatus)))
        content.addSubview(button(t("showLogs"), x: 28, y: actionRow2Y, width: actionColW, action: #selector(showLogs)))
        content.addSubview(button(t("runDoctor"), x: actionCol2X, y: actionRow2Y, width: actionColW, action: #selector(runDoctor)))
        let copyright = label("v\(controller.appVersion) - Copyright 2026 ezBuilder. All rights reserved.", x: 28, y: footerY, width: 340, size: 11)
        content.addSubview(copyright)
        content.addSubview(button(t("cancel"), x: 338, y: footerButtonY, width: 78, action: #selector(cancelSettings)))
        let saveButton = button(t("save"), x: 426, y: footerButtonY, width: 86, action: #selector(saveSettings))
        saveButton.keyEquivalent = "\r"
        content.addSubview(saveButton)

        settingsWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func settingsLanguageChanged(_ sender: NSPopUpButton) {
        if let language = sender.selectedItem?.representedObject as? String {
            controller.setPreferredLanguage(language)
            rebuildMenu()
            refreshStatus()
            settingsWindow?.close()
            showSettings()
        }
    }

    @objc private func cancelSettings() {
        settingsWindow?.close()
    }

    @objc private func showFixedDomainSetup() {
        let host = settingsHostField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayHost = host?.isEmpty == false ? host! : "chatgpt2codex.example.com"
        let message = String(format: t("fixedDomainSetupInfo"), "\(controller.port)", displayHost)
        let alert = NSAlert()
        alert.messageText = t("fixedDomainSetupTitle")
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: t("openCloudflare"))
        alert.addButton(withTitle: t("copyFixedDomainSteps"))
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            if let url = URL(string: "https://dash.cloudflare.com/?to=/:account/zero-trust/networks/tunnels") {
                NSWorkspace.shared.open(url)
            }
        } else if response == .alertSecondButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(message, forType: .string)
            let copiedAlert = NSAlert()
            copiedAlert.messageText = t("fixedDomainSetupTitle")
            copiedAlert.informativeText = t("fixedDomainStepsCopied")
            copiedAlert.alertStyle = .informational
            copiedAlert.addButton(withTitle: t("ok"))
            copiedAlert.runModal()
        }
    }

    @objc private func saveSettings() {
        guard let projectField = settingsProjectField,
              let launchAtLogin = settingsLaunchAtLogin,
              let startOnLaunch = settingsStartOnLaunch,
              let publicTunnel = settingsPublicTunnel,
              let hostField = settingsHostField,
              let portField = settingsPortField
        else { return }
        let projectPath = projectField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if projectPath.isEmpty {
            controller.clearSelectedProjectFolder()
        } else {
            let projectURL = URL(fileURLWithPath: projectPath)
            guard controller.ensureWorkspaceDirectory(projectURL) else {
                let invalidProjectAlert = NSAlert()
                invalidProjectAlert.messageText = t("projectMarkerTitle")
                invalidProjectAlert.informativeText = t("projectMarkerInfo")
                invalidProjectAlert.addButton(withTitle: t("ok"))
                invalidProjectAlert.runModal()
                return
            }
            controller.setSelectedProjectFolder(projectURL)
        }
        controller.setLaunchAtLogin(launchAtLogin.state == .on)
        controller.setStartMCPOnLaunch(startOnLaunch.state == .on)
        controller.setEnablePublicTunnel(publicTunnel.state == .on)
        controller.setPublicHostname(hostField.stringValue)
        if let port = Int(portField.stringValue), port > 0 {
            controller.setPort(port)
        }
        let shouldRestart = latestHealth || controller.isManagedProcessRunning
        settingsWindow?.close()
        rebuildMenu()
        restartAfterSavedSettingsIfConfirmed(shouldRestart)
    }

    @objc private func browseProjectFolderFromSettings() {
        let panel = NSOpenPanel()
        panel.title = t("selectProjectFolderTitle")
        panel.prompt = t("select")
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = controller.selectedProjectFolder ?? URL(fileURLWithPath: controller.workspace)
        NSApp.activate(ignoringOtherApps: true)
        let applySelection: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            _ = self.controller.ensureWorkspaceDirectory(url)
            self.settingsProjectField?.stringValue = url.path
        }
        if let window = settingsWindow {
            panel.beginSheetModal(for: window, completionHandler: applySelection)
        } else {
            panel.begin(completionHandler: applySelection)
        }
    }

    @objc private func toggleLaunchAtLogin(_ sender: NSMenuItem) {
        controller.setLaunchAtLogin(sender.state != .on)
        rebuildMenu()
        refreshStatus()
    }

    @objc private func toggleStartOnLaunch(_ sender: NSMenuItem) {
        controller.setStartMCPOnLaunch(sender.state != .on)
        rebuildMenu()
        refreshStatus()
    }

    @objc private func toggleAutoCheckUpdates(_ sender: NSMenuItem) {
        controller.setAutoCheckUpdates(sender.state != .on)
        rebuildMenu()
        refreshStatus()
    }

    @objc private func openLocalHealth() {
        NSWorkspace.shared.open(controller.healthURL)
    }

    @objc private func openPublicHealth() {
        guard let url = controller.publicHealthURL else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openStatus() {
        NSWorkspace.shared.open(controller.publicHealthURL ?? controller.healthURL)
    }

    @objc private func copyConnectorURL() {
        guard let url = controller.connectorURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }

    private func copySecret(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    private func ownerTokenKeychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: ownerTokenKeychainService,
            kSecAttrAccount as String: ownerTokenKeychainAccount,
        ]
    }

    private func storeOwnerTokenInKeychain(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }
        var query = ownerTokenKeychainQuery()
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    private func loadOwnerTokenFromKeychain() -> String? {
        var query = ownerTokenKeychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else {
            return nil
        }
        return token
    }

    private func showInfo(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func restartAfterOwnerTokenChange() {
        let shouldRestart = latestHealth || controller.isManagedProcessRunning || controller.startMCPOnLaunch
        rebuildMenu()
        if shouldRestart {
            statusMenuItem.title = "ChatGPT To Codex: \(t("statusRestarting"))"
            controller.restart { [weak self] _ in
                self?.refreshStatus()
            }
        } else {
            refreshStatus()
        }
    }

    @objc private func generateAndCopyOwnerToken() {
        if settingsOwnerTokenConfigured {
            let confirm = NSAlert()
            confirm.messageText = t("ownerTokenRegenerateTitle")
            confirm.informativeText = t("ownerTokenRegenerateInfo")
            confirm.addButton(withTitle: t("ownerTokenGenerateCopy"))
            confirm.addButton(withTitle: t("cancel"))
            NSApp.activate(ignoringOtherApps: true)
            guard confirm.runModal() == .alertFirstButtonReturn else { return }
        }
        settingsOwnerTokenButton?.isEnabled = false
        settingsOwnerTokenButton?.title = t("ownerTokenGenerating")
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let token = try self.controller.generateOwnerToken()
                DispatchQueue.main.async {
                    self.storeOwnerTokenInKeychain(token)
                    self.copySecret(token)
                    self.settingsOwnerTokenConfigured = true
                    self.settingsOwnerTokenStatus?.stringValue = self.t("ownerTokenCopiedStatus")
                    self.settingsOwnerTokenStatus?.textColor = .systemGreen
                    self.settingsOwnerTokenButton?.isEnabled = true
                    self.settingsOwnerTokenButton?.title = self.t("ownerTokenGenerateCopy")
                    self.settingsOwnerTokenCopyButton?.isEnabled = true
                    self.refreshStatus()
                }
            } catch {
                DispatchQueue.main.async {
                    self.settingsOwnerTokenButton?.isEnabled = true
                    self.settingsOwnerTokenButton?.title = self.t("ownerTokenGenerateCopy")
                    self.showInfo(self.t("doctorTitle"), error.localizedDescription)
                }
            }
        }
    }

    @objc private func copyStoredOwnerToken() {
        guard let token = loadOwnerTokenFromKeychain() else {
            showInfo(t("ownerTokenGeneratedTitle"), t("ownerTokenCopyUnavailable"))
            return
        }
        copySecret(token)
        settingsOwnerTokenStatus?.stringValue = t("ownerTokenCopiedStatus")
        settingsOwnerTokenStatus?.textColor = .systemGreen
    }

    @objc private func openGithubRepository() {
        NSWorkspace.shared.open(controller.githubRepoURL)
    }

    @objc private func checkForUpdates() {
        controller.checkForUpdates { [weak self] message, url in
            guard let self else { return }
            let alert = NSAlert()
            alert.messageText = self.t("updatesTitle")
            alert.informativeText = message
            alert.addButton(withTitle: url == nil ? self.t("ok") : self.t("openReleases"))
            alert.addButton(withTitle: self.t("close"))
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn, let url {
                NSWorkspace.shared.open(url)
            }
            self.refreshStatus()
        }
    }

    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = t("aboutTitle")
        alert.informativeText = t("aboutInfo")
        alert.addButton(withTitle: t("openGithubButton"))
        alert.addButton(withTitle: t("ok"))
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(controller.githubRepoURL)
        }
    }

    @objc private func showLogs() {
        if !FileManager.default.fileExists(atPath: controller.logFile.path) {
            FileManager.default.createFile(atPath: controller.logFile.path, contents: nil)
        }
        let text = (try? String(contentsOf: controller.logFile, encoding: .utf8)) ?? ""
        showTextWindow(title: t("showLogs"), text: text.isEmpty ? controller.logFile.path : text, doctor: false)
    }

    @objc private func runDoctor() {
        showTextWindow(title: t("doctorTitle"), text: t("doctorRunning"), doctor: true)
        DispatchQueue.global(qos: .userInitiated).async {
            let report = self.controller.runDoctor(repair: true)
            DispatchQueue.main.async {
                self.showTextWindow(title: self.t("doctorTitle"), text: report, doctor: true)
            }
        }
    }

    private func showTextWindow(title: String, text: String, doctor: Bool) {
        let maxLength = 200_000
        let displayText = text.count > maxLength ? String(text.suffix(maxLength)) : text

        if doctor {
            doctorWindow?.close()
        } else {
            logWindow?.close()
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 860, height: 560),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false

        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 860, height: 560))
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autoresizingMask = [.width, .height]

        let textView = NSTextView(frame: scrollView.bounds)
        textView.isEditable = false
        textView.isSelectable = true
        textView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.string = displayText
        textView.autoresizingMask = [.width, .height]
        scrollView.documentView = textView
        window.contentView = scrollView
        if doctor {
            doctorWindow = window
        } else {
            logWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
private let delegate = StatusBarAppDelegate()
app.delegate = delegate
app.run()
