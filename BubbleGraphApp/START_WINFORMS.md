# Ghid de Pornire BubbleGraphApp (WinForms)

Acest ghid explică pașii necesari pentru a porni aplicația BubbleGraphApp pe Windows, folosind interfața desktop WinForms.

## Cerințe preliminare
- Windows 10 sau mai nou
- .NET 8.0 instalat ([download .NET 8.0 Runtime & SDK](https://dotnet.microsoft.com/en-us/download/dotnet/8.0))
- (Opțional) Python 3.10+ pentru backend (dacă vrei funcționalitate completă)

## Pași de pornire

### 1. Compilează aplicația (dacă nu există deja executabilul)
- Deschide un terminal în folderul `BubbleGraphApp`:
  ```powershell
  cd BubbleGraphApp
  dotnet build -c Debug
  ```
- Executabilul va fi generat în `BubbleGraphApp\bin\Debug\net8.0-windows\win-x64\BubbleGraphApp.exe`

### 2. Pornește backend-ul (opțional, pentru funcționalitate completă)
- Deschide un terminal nou și navighează la folderul `backend`:
  ```powershell
  cd backend
  pip install -r requirements.txt
  uvicorn main:app --reload --port 8000
  ```
- Backend-ul FastAPI va rula pe `http://localhost:8000`

### 3. Pornește aplicația desktop
- Navighează la folderul cu executabilul:
  ```powershell
  cd BubbleGraphApp\bin\Debug\net8.0-windows\win-x64
  ```
- Rulează aplicația:
  ```powershell
  ./BubbleGraphApp.exe
  ```

## Notă
- Aplicația va deschide o fereastră desktop cu interfața BubbleGraph.
- Dacă backend-ul nu este pornit, anumite funcții (salvare, încărcare proiect, query BIM) pot fi indisponibile.

---

Dacă întâmpini erori la pornire, verifică dacă ai instalat corect .NET 8.0 și dacă backend-ul rulează pe portul 8000.
